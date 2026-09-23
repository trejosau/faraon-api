import 'dotenv/config';
import crypto from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import cors from 'cors';
import express from 'express';
import jwt from 'jsonwebtoken';
import { Pool, type PoolClient } from 'pg';
import Stripe from 'stripe';
import { Resend } from 'resend';

const app = express();
const port = Number(process.env.PORT ?? 4000);
const clientUrls = (process.env.CLIENT_URL ?? 'http://localhost:4300').split(',').map((origin) => origin.trim()).filter(Boolean);
const clientUrl = clientUrls[0] ?? 'http://localhost:4300';
const jwtSecret = process.env.JWT_SECRET ?? 'development-only-change-me';
const adminEmail = (process.env.ADMIN_EMAIL ?? 'admin@gmail.com').toLowerCase();
const adminPassword = process.env.ADMIN_PASSWORD ?? '1234';
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

const databaseConnectionString = process.env.POSTGRES_URL_NON_POOLING ?? process.env.POSTGRES_URL ?? process.env.POSTGRES_PRISMA_URL;
function poolFromConnectionString(connectionString: string): Pool {
  const parsed = new URL(connectionString);
  parsed.searchParams.delete('sslmode');
  return new Pool({ connectionString: parsed.toString(), ssl: { rejectUnauthorized: false }, max: 3 });
}

const db = databaseConnectionString
  ? poolFromConnectionString(databaseConnectionString)
  : process.env.POSTGRES_HOST
    ? new Pool({
      host: process.env.POSTGRES_HOST,
      port: Number(process.env.POSTGRES_PORT ?? 5432),
      user: process.env.POSTGRES_USER ?? 'postgres',
      password: process.env.POSTGRES_PASSWORD ?? '',
      database: process.env.POSTGRES_DATABASE ?? 'postgres',
      ssl: { rejectUnauthorized: false },
      max: 3
    })
    : null;

const migrationFile = [
  path.resolve(process.cwd(), 'migrations/001_initial.sql'),
  path.resolve(process.cwd(), 'api/migrations/001_initial.sql'),
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../migrations/001_initial.sql'),
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../migrations/001_initial.sql')
].find((candidate) => existsSync(candidate));

async function migrateDatabase(pool: Pool): Promise<void> {
  if (!migrationFile) throw new Error('DATABASE_MIGRATION_FILE_NOT_FOUND');
  await pool.query(await readFile(migrationFile, 'utf8'));
}

const databaseReady = db ? migrateDatabase(db) : Promise.resolve();

const catalogPrices: Record<string, { name: string; cash: number; credit: number }> = {
  'comedor-160': { name: 'Comedor para 4 personas', cash: 11800, credit: 13900 },
  'sala-modular': { name: 'Sala modular', cash: 16900, credit: 19800 },
  bufetero: { name: 'Bufetero de madera oscura', cash: 4300, credit: 5100 },
  'comedor-180': { name: 'Comedor para 6 personas', cash: 13600, credit: 16000 },
  'sala-esquinera': { name: 'Sala tipo escuadra', cash: 14500, credit: 18500 },
  'comedor-100': { name: 'Comedor compacto', cash: 8900, credit: 8900 }
};
const catalogStock: Record<string, number> = {
  'comedor-160': 2,
  'sala-modular': 1,
  bufetero: 3,
  'comedor-180': 0,
  'sala-esquinera': 2,
  'comedor-100': 4
};

type DeliveryMethod = 'local' | 'national';
type ShippingRequest = {
  method?: DeliveryMethod;
  zone?: string;
  amountMxn?: number;
  address?: { name?: string; phone?: string; line1?: string; city?: string; state?: string; postalCode?: string };
};
type UserRow = { id: number | string; name: string; email: string; password_hash: string };
type ResetRow = { id: number | string; user_id: number | string; email: string };
type OrderRow = { id: number | string; [key: string]: unknown };

function normalizeShipping(shipping: ShippingRequest | undefined): { method: DeliveryMethod; zone: string; amountMxn: number; address: NonNullable<ShippingRequest['address']> } {
  const address = shipping?.address ?? {};
  const method = shipping?.method === 'national' ? 'national' : 'local';
  const amountMxn = Math.max(0, Math.round(Number(shipping?.amountMxn ?? 0)));
  return { method, zone: method === 'national' ? 'Nacional' : 'Comarca Lagunera', amountMxn, address };
}

function optionalUserId(request: express.Request): number | null {
  const token = request.header('authorization')?.replace(/^Bearer\s+/i, '');
  try {
    const claims = token ? jwt.verify(token, jwtSecret) as { sub?: string | number } : null;
    const userId = Number(claims?.sub);
    return Number.isInteger(userId) && userId > 0 ? userId : null;
  } catch {
    return null;
  }
}

const allowedOrigins = new Set([...clientUrls, 'http://localhost:4300', 'http://127.0.0.1:4300']);

app.use((request, response, next) => {
  const requestId = request.header('x-request-id') ?? crypto.randomUUID();
  response.locals.requestId = requestId;
  response.setHeader('x-request-id', requestId);
  next();
});

const corsOptions = {
  origin: (origin: string | undefined, callback: (error: Error | null, allow?: boolean) => void) => {
    if (!origin || allowedOrigins.has(origin)) {
      callback(null, true);
      return;
    }
    callback(new Error('CORS_ORIGIN_NOT_ALLOWED'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id']
};

app.use(cors(corsOptions));
app.options(/.*/, cors(corsOptions));
app.use(express.json({ limit: '1mb' }));
app.use(async (_request, _response, next) => {
  try {
    await databaseReady;
    next();
  } catch (error) {
    next(error);
  }
});

app.get('/api/health', (_request, response) => {
  response.json({ ok: true, stripe: Boolean(stripe), database: Boolean(db), resend: Boolean(resend) });
});

app.post('/api/contact', async (request, response) => {
  const { name, email, phone, message } = request.body as Record<string, unknown>;
  if (![name, email, phone, message].every((value) => typeof value === 'string' && value.trim())) {
    response.status(400).json({ message: 'Completa nombre, correo, teléfono y mensaje.' });
    return;
  }
  if (!db) {
    response.status(503).json({ message: 'La API está activa, pero Postgres todavía no está configurado.' });
    return;
  }
  await db.query('INSERT INTO contact_messages (name, email, phone, message) VALUES ($1, $2, $3, $4)', [String(name), String(email), String(phone), String(message)]);
  response.status(201).json({ message: 'Mensaje recibido. Te contactaremos pronto.' });
});

app.post('/api/auth/login', async (request, response) => {
  const { email, password } = request.body as { email?: string; password?: string };
  const normalizedEmail = email?.toLowerCase().trim();
  if (normalizedEmail === adminEmail && password === adminPassword) {
    const token = jwt.sign({ sub: 'admin', email: adminEmail, name: 'Administrador', role: 'admin' }, jwtSecret, { expiresIn: '7d' });
    response.json({ ok: true, token, role: 'admin', name: 'Administrador', message: 'Bienvenido al panel de El Faraón.' });
    return;
  }
  if (!email || !password || !db) {
    response.status(400).json({ message: !db ? 'Postgres todavía no está configurado.' : 'Correo y contraseña son obligatorios.' });
    return;
  }
  const { rows } = await db.query<UserRow>('SELECT id, name, email, password_hash FROM users WHERE email = $1 LIMIT 1', [normalizedEmail ?? '']);
  const user = rows[0];
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    response.status(401).json({ message: 'Correo o contraseña incorrectos.' });
    return;
  }
  const token = jwt.sign({ sub: user.id, email: user.email, name: user.name }, jwtSecret, { expiresIn: '7d' });
  response.json({ ok: true, token, message: `Bienvenido, ${user.name}.` });
});

app.post('/api/auth/forgot-password', async (request, response) => {
  const { email } = request.body as { email?: string };
  if (!email || !db) {
    response.status(400).json({ message: !db ? 'Postgres todavía no está configurado.' : 'Escribe tu correo.' });
    return;
  }
  const { rows } = await db.query<ResetRow>('SELECT id, email FROM users WHERE email = $1 LIMIT 1', [email.toLowerCase().trim()]);
  const user = rows[0];
  const safeMessage = 'Si el correo existe, recibirás un enlace para recuperar tu contraseña.';
  if (!user) {
    response.json({ ok: true, message: safeMessage });
    return;
  }
  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  await db.query('INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, NOW() + INTERVAL \'1 hour\')', [user.id, tokenHash]);
  if (resend) {
    const resetUrl = `${clientUrl}/?reset=${rawToken}`;
    await resend.emails.send({
      from: process.env.RESEND_FROM ?? 'onboarding@resend.dev',
      to: user.email,
      subject: 'Recupera tu acceso a El Faraón',
      html: `<p>Recibimos una solicitud para cambiar tu contraseña.</p><p><a href="${resetUrl}">Crear nueva contraseña</a></p><p>Este enlace expira en una hora.</p>`
    });
  }
  response.json({ ok: true, message: safeMessage });
});

app.post('/api/auth/reset-password', async (request, response) => {
  const { token, password } = request.body as { token?: string; password?: string };
  if (!token || !password || password.length < 8 || !db) {
    response.status(400).json({ message: !db ? 'Postgres todavía no está configurado.' : 'El token y una contraseña de 8 caracteres son obligatorios.' });
    return;
  }
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const { rows } = await db.query<ResetRow>('SELECT id, user_id FROM password_reset_tokens WHERE token_hash = $1 AND used_at IS NULL AND expires_at > NOW() LIMIT 1', [tokenHash]);
  const reset = rows[0];
  if (!reset) {
    response.status(400).json({ message: 'El enlace ya expiró o no es válido.' });
    return;
  }
  await db.query('UPDATE users SET password_hash = $1 WHERE id = $2', [await bcrypt.hash(password, 12), reset.user_id]);
  await db.query('UPDATE password_reset_tokens SET used_at = NOW() WHERE id = $1', [reset.id]);
  response.json({ ok: true, message: 'Contraseña actualizada.' });
});

app.post('/api/checkout/create-payment-intent', async (request, response) => {
  const { paymentMode, items, shipping: shippingRequest, installmentMonths } = request.body as { paymentMode?: 'cash' | 'credit'; items?: Array<{ productId?: string; quantity?: number }>; shipping?: ShippingRequest; installmentMonths?: 3 | 6 | null };
  if (!stripe) {
    response.status(503).json({ ok: false, code: 'STRIPE_NOT_CONFIGURED', requestId: response.locals.requestId, message: 'Stripe todavía no está configurado en la API.' });
    return;
  }
  if (!items?.length || (paymentMode !== 'cash' && paymentMode !== 'credit')) {
    response.status(400).json({ ok: false, code: 'PAYMENT_INPUT_INVALID', requestId: response.locals.requestId, message: 'Selecciona una forma de pago y al menos una pieza.' });
    return;
  }

  const mode = paymentMode;
  const shipping = normalizeShipping(shippingRequest);
  let amount = 0;
  for (const item of items) {
    const product = item.productId ? catalogPrices[item.productId] : undefined;
    const quantity = Math.max(1, Math.min(Number(item.quantity ?? 1), 20));
    if (!product) {
      response.status(400).json({ ok: false, code: 'PRODUCT_UNAVAILABLE', requestId: response.locals.requestId, message: 'Una de las piezas ya no está disponible.' });
      return;
    }
    if (quantity > (catalogStock[item.productId as string] ?? 0)) {
      response.status(409).json({ ok: false, code: 'INSUFFICIENT_STOCK', requestId: response.locals.requestId, message: `No hay suficientes unidades de ${product.name}.` });
      return;
    }
    amount += (mode === 'cash' ? product.cash : product.credit) * quantity * 100;
  }

  amount += shipping.amountMxn * 100;
  const paymentIntent = await stripe.paymentIntents.create({
    amount,
    currency: 'mxn',
    payment_method_types: ['card'],
    payment_method_options: { card: { installments: { enabled: mode === 'credit' } } },
    shipping: {
      name: shipping.address.name ?? 'Cliente El Faraón',
      phone: shipping.address.phone,
      address: { line1: shipping.address.line1 ?? '', city: shipping.address.city ?? '', state: shipping.address.state ?? '', postal_code: shipping.address.postalCode ?? '', country: 'MX' }
    },
    metadata: { paymentMode: mode, installmentMonths: String(installmentMonths ?? ''), deliveryMethod: shipping.method, shippingZone: shipping.zone, shippingAmountMxn: String(shipping.amountMxn) }
  });

  response.json({ ok: true, clientSecret: paymentIntent.client_secret, paymentIntentId: paymentIntent.id, amount: amount / 100, message: mode === 'credit' ? 'Stripe mostrará los meses disponibles para tu tarjeta.' : 'Pago contado listo para confirmar con tarjeta.' });
});

app.post('/api/orders', async (request, response) => {
  const { stripePaymentIntentId, paymentMode, installmentMonths: _installmentMonths, amountMxn, items, shipping: shippingRequest } = request.body as { stripePaymentIntentId?: string; paymentMode?: 'cash' | 'credit'; installmentMonths?: 3 | 6 | null; amountMxn?: number; items?: Array<{ productId?: string; quantity?: number }>; shipping?: ShippingRequest };
  if (!db) {
    response.status(503).json({ ok: false, code: 'DATABASE_NOT_CONFIGURED', message: 'El pago fue recibido, pero Postgres todavía no está configurado para guardar el pedido.' });
    return;
  }
  if (!stripe || !stripePaymentIntentId || !items?.length || (paymentMode !== 'cash' && paymentMode !== 'credit')) {
    response.status(400).json({ ok: false, code: 'ORDER_INPUT_INVALID', message: 'Faltan datos para registrar el pedido.' });
    return;
  }
  const paymentIntent = await stripe.paymentIntents.retrieve(stripePaymentIntentId);
  if (paymentIntent.status !== 'succeeded' && paymentIntent.status !== 'processing') {
    response.status(409).json({ ok: false, code: 'PAYMENT_NOT_CONFIRMED', message: 'El pago todavía no está confirmado.' });
    return;
  }
  const shipping = normalizeShipping(shippingRequest);
  const userId = optionalUserId(request);
  const connection: PoolClient = await db.connect();
  try {
    await connection.query('BEGIN');
    const { rows: orderRows } = await connection.query<{ id: number | string }>(
      'INSERT INTO orders (user_id, stripe_payment_intent_id, payment_mode, amount_mxn, shipping_amount_mxn, delivery_method, shipping_zone, recipient_name, recipient_phone, address_line, city, state, postal_code, status) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING id',
      [userId, stripePaymentIntentId, paymentMode, Number(amountMxn ?? paymentIntent.amount / 100), shipping.amountMxn, shipping.method, shipping.zone, shipping.address.name ?? '', shipping.address.phone ?? '', shipping.address.line1 ?? '', shipping.address.city ?? '', shipping.address.state ?? '', shipping.address.postalCode ?? '', 'paid']
    );
    const orderId = orderRows[0].id;
    for (const item of items) {
      const product = item.productId ? catalogPrices[item.productId] : undefined;
      if (!product) throw new Error('PRODUCT_UNAVAILABLE');
      const quantity = Math.max(1, Math.min(Number(item.quantity ?? 1), 20));
      if (quantity > (catalogStock[item.productId as string] ?? 0)) throw new Error('INSUFFICIENT_STOCK');
      await connection.query('INSERT INTO order_items (order_id, product_id, quantity, unit_amount_mxn) VALUES ($1, $2, $3, $4)', [orderId, item.productId as string, quantity, paymentMode === 'cash' ? product.cash : product.credit]);
    }
    await connection.query('COMMIT');
    for (const item of items) {
      const productId = item.productId as string;
      catalogStock[productId] -= Math.max(1, Math.min(Number(item.quantity ?? 1), 20));
    }
    response.status(201).json({ ok: true, orderId: Number(orderId), message: 'Pedido registrado y listo para preparación.' });
  } catch (error) {
    await connection.query('ROLLBACK');
    throw error;
  } finally {
    connection.release();
  }
});

app.get('/api/orders', async (request, response) => {
  if (!db) {
    response.status(503).json({ ok: false, code: 'DATABASE_NOT_CONFIGURED', message: 'Postgres todavía no está configurado.' });
    return;
  }
  const userId = optionalUserId(request);
  if (!userId) {
    response.status(401).json({ ok: false, code: 'AUTH_REQUIRED', message: 'Inicia sesión para consultar tus pedidos de cuenta.' });
    return;
  }
  const { rows: orders } = await db.query<OrderRow>('SELECT id, stripe_payment_intent_id, payment_mode, amount_mxn, shipping_amount_mxn, delivery_method, shipping_zone, recipient_name, recipient_phone, address_line, city, state, postal_code, carrier, tracking_number, tracking_url, shipping_status, status, created_at FROM orders WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100', [userId]);
  const orderIds = orders.map((order) => Number(order.id)).filter((id) => Number.isInteger(id) && id > 0);
  const { rows: items } = orderIds.length
    ? await db.query('SELECT order_id, product_id, quantity, unit_amount_mxn FROM order_items WHERE order_id = ANY($1::bigint[]) ORDER BY id ASC', [orderIds])
    : { rows: [] };
  response.json({ ok: true, orders, items });
});

function requireAdmin(request: express.Request, response: express.Response, next: express.NextFunction): void {
  const token = request.header('authorization')?.replace(/^Bearer\s+/i, '');
  try {
    const claims = token ? jwt.verify(token, jwtSecret) as { role?: string } : null;
    if (claims?.role !== 'admin') throw new Error('ADMIN_REQUIRED');
    next();
  } catch {
    response.status(401).json({ ok: false, code: 'ADMIN_REQUIRED', message: 'Necesitas una sesión de administrador.' });
  }
}

app.get('/api/admin/orders', requireAdmin, async (_request, response) => {
  if (!db) {
    response.status(503).json({ ok: false, code: 'DATABASE_NOT_CONFIGURED', message: 'Postgres todavía no está configurado.' });
    return;
  }
  const { rows } = await db.query('SELECT id, stripe_payment_intent_id, payment_mode, amount_mxn, status, delivery_method, shipping_zone, recipient_name, recipient_phone, address_line, city, state, postal_code, carrier, tracking_number, tracking_url, shipping_status, created_at FROM orders ORDER BY created_at DESC LIMIT 100');
  response.json({ ok: true, orders: rows });
});

app.patch('/api/admin/orders/:id/status', requireAdmin, async (request, response) => {
  if (!db) {
    response.status(503).json({ ok: false, code: 'DATABASE_NOT_CONFIGURED', message: 'Postgres todavía no está configurado.' });
    return;
  }
  const { status, carrier, trackingNumber, trackingUrl, shippingStatus } = request.body as { status?: string; carrier?: string; trackingNumber?: string; trackingUrl?: string; shippingStatus?: string };
  const allowedStatuses = new Set(['pending', 'paid', 'preparing', 'shipped', 'out_for_delivery', 'delivered']);
  if (!status || !allowedStatuses.has(status)) {
    response.status(400).json({ ok: false, code: 'ORDER_STATUS_INVALID', message: 'Estado de pedido no válido.' });
    return;
  }
  await db.query('UPDATE orders SET status = $1, carrier = $2, tracking_number = $3, tracking_url = $4, shipping_status = $5 WHERE id = $6', [status, carrier ?? null, trackingNumber ?? null, trackingUrl ?? null, shippingStatus ?? status, Number(request.params.id)]);
  response.json({ ok: true, message: 'Pedido actualizado.' });
});

app.post('/api/checkout/create-session', async (request, response) => {
  const { paymentMode, items } = request.body as { paymentMode?: 'cash' | 'credit'; items?: Array<{ productId?: string; quantity?: number }> };
  if (!stripe) {
    response.status(503).json({ ok: false, code: 'STRIPE_NOT_CONFIGURED', requestId: response.locals.requestId, message: 'Stripe todavía no está configurado en la API.' });
    return;
  }
  if (!items?.length || (paymentMode !== 'cash' && paymentMode !== 'credit')) {
    response.status(400).json({ ok: false, code: 'CHECKOUT_INPUT_INVALID', requestId: response.locals.requestId, message: 'Selecciona una forma de pago y al menos una pieza.' });
    return;
  }
  const mode = paymentMode;
  const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = [];
  for (const item of items) {
    const product = item.productId ? catalogPrices[item.productId] : undefined;
    const quantity = Math.max(1, Math.min(Number(item.quantity ?? 1), 20));
    if (!product) {
      response.status(400).json({ ok: false, code: 'PRODUCT_UNAVAILABLE', requestId: response.locals.requestId, message: 'Una de las piezas ya no está disponible.' });
      return;
    }
    lineItems.push({ price_data: { currency: 'mxn', product_data: { name: product.name }, unit_amount: (mode === 'cash' ? product.cash : product.credit) * 100 }, quantity });
  }
  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    ui_mode: 'embedded',
    line_items: lineItems,
    metadata: { paymentMode: mode },
    return_url: `${clientUrl}/?checkout=return`,
    ...(mode === 'credit' ? { payment_method_options: { card: { installments: { enabled: true } } } } : {})
  });
  response.json({ ok: true, sessionId: session.id, clientSecret: session.client_secret, message: 'Checkout seguro embebido listo.' });
});

app.use((_request, response) => {
  response.status(404).json({ ok: false, code: 'NOT_FOUND', message: 'La ruta solicitada no existe.' });
});

app.use((error: unknown, request: express.Request, response: express.Response, _next: express.NextFunction) => {
  const candidate = error as { code?: string; message?: string; status?: number; statusCode?: number };
  const requestId = response.locals.requestId ?? crypto.randomUUID();
  const errorCode = candidate.code ?? 'API_ERROR';
  console.error(JSON.stringify({ level: 'error', scope: 'api', requestId, method: request.method, path: request.path, code: errorCode, message: candidate.message ?? 'Unknown error' }));

  let message = 'Ocurrió un error inesperado. Inténtalo de nuevo.';
  let status = candidate.statusCode ?? candidate.status ?? 500;
  if (errorCode === 'CORS_ORIGIN_NOT_ALLOWED') {
    message = 'La API rechazó el origen de esta pantalla. Confirma CLIENT_URL en Vercel.';
    status = 403;
  } else if (errorCode === '28P01') {
    message = 'Postgres rechazó las credenciales configuradas.';
    status = 503;
  } else if (errorCode === 'ECONNREFUSED' || errorCode === 'ENOTFOUND') {
    message = 'No se pudo conectar con Postgres. Confirma la configuración de Supabase.';
    status = 503;
  } else if (errorCode === '42P01' || errorCode === 'DATABASE_MIGRATION_FILE_NOT_FOUND') {
    message = 'La API no encontró las tablas o la migración inicial de Postgres.';
    status = 503;
  } else if (errorCode === '23505') {
    message = 'Este pedido ya fue registrado.';
    status = 409;
  } else if (error instanceof Stripe.errors.StripeError) {
    message = `Stripe: ${candidate.message ?? 'Stripe rechazó la operación.'}`;
    status = 502;
  }

  response.status(status).json({ ok: false, code: errorCode, message, requestId });
});

export default app;

if (process.env.VERCEL !== '1') {
  app.listen(port, () => console.log(`El Faraón API disponible en http://localhost:${port}`));
}
