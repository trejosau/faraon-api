import 'dotenv/config';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import cors from 'cors';
import express from 'express';
import jwt from 'jsonwebtoken';
import mysql from 'mysql2/promise';
import Stripe from 'stripe';
import { Resend } from 'resend';

const app = express();
const port = Number(process.env.PORT ?? 4000);
const clientUrl = process.env.CLIENT_URL ?? 'http://localhost:4300';
const jwtSecret = process.env.JWT_SECRET ?? 'development-only-change-me';
const adminEmail = (process.env.ADMIN_EMAIL ?? 'admin@gmail.com').toLowerCase();
const adminPassword = process.env.ADMIN_PASSWORD ?? '1234';
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
const db = process.env.MYSQL_DATABASE ? mysql.createPool({
  host: process.env.MYSQL_HOST ?? '127.0.0.1',
  port: Number(process.env.MYSQL_PORT ?? 3306),
  user: process.env.MYSQL_USER ?? 'root',
  password: process.env.MYSQL_PASSWORD ?? '',
  database: process.env.MYSQL_DATABASE,
  waitForConnections: true,
  connectionLimit: 5,
  charset: 'utf8mb4'
}) : null;

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
type ShippingRequest = { method?: DeliveryMethod; zone?: string; amountMxn?: number; address?: { name?: string; phone?: string; line1?: string; city?: string; state?: string; postalCode?: string } };

function normalizeShipping(shipping: ShippingRequest | undefined): { method: DeliveryMethod; zone: string; amountMxn: number; address: NonNullable<ShippingRequest['address']> } {
  const address = shipping?.address ?? {};
  const method = shipping?.method === 'national' ? 'national' : 'local';
  const amountMxn = Math.max(0, Math.round(Number(shipping?.amountMxn ?? 0)));
  return { method, zone: method === 'national' ? 'Nacional' : 'Comarca Lagunera', amountMxn, address };
}

const allowedOrigins = new Set([clientUrl, 'http://localhost:4300', 'http://127.0.0.1:4300']);

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
    response.status(503).json({ message: 'La API está activa, pero MySQL todavía no está configurado.' });
    return;
  }
  await db.execute('INSERT INTO contact_messages (name, email, phone, message) VALUES (?, ?, ?, ?)', [String(name), String(email), String(phone), String(message)]);
  response.status(201).json({ message: 'Mensaje recibido. Te contactaremos pronto.' });
});

app.post('/api/auth/login', async (request, response) => {
  const { email, password } = request.body as { email?: string; password?: string };
  const normalizedEmail = email?.toLowerCase().trim();
  if (normalizedEmail === adminEmail && password === adminPassword) {
    const token = jwt.sign({ sub: 'admin', email: adminEmail, name: 'Administrador', role: 'admin' }, jwtSecret, { expiresIn: '7d' });
    response.json({ ok: true, token, role: 'admin', name: 'Administrador', message: 'Bienvenido al panel de El Faraon.' });
    return;
  }
  if (!email || !password || !db) {
    response.status(400).json({ message: !db ? 'MySQL todavía no está configurado.' : 'Correo y contraseña son obligatorios.' });
    return;
  }
  const [rows] = await db.execute<mysql.RowDataPacket[]>('SELECT id, name, email, password_hash FROM users WHERE email = ? LIMIT 1', [normalizedEmail ?? '']);
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
    response.status(400).json({ message: !db ? 'MySQL todavía no está configurado.' : 'Escribe tu correo.' });
    return;
  }
  const [rows] = await db.execute<mysql.RowDataPacket[]>('SELECT id, email FROM users WHERE email = ? LIMIT 1', [email.toLowerCase().trim()]);
  const user = rows[0];
  const safeMessage = 'Si el correo existe, recibirás un enlace para recuperar tu contraseña.';
  if (!user) {
    response.json({ ok: true, message: safeMessage });
    return;
  }
  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  await db.execute('INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 1 HOUR))', [user.id, tokenHash]);
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
    response.status(400).json({ message: !db ? 'MySQL todavía no está configurado.' : 'El token y una contraseña de 8 caracteres son obligatorios.' });
    return;
  }
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const [rows] = await db.execute<mysql.RowDataPacket[]>('SELECT id, user_id FROM password_reset_tokens WHERE token_hash = ? AND used_at IS NULL AND expires_at > NOW() LIMIT 1', [tokenHash]);
  const reset = rows[0];
  if (!reset) {
    response.status(400).json({ message: 'El enlace ya expiró o no es válido.' });
    return;
  }
  await db.execute('UPDATE users SET password_hash = ? WHERE id = ?', [await bcrypt.hash(password, 12), reset.user_id]);
  await db.execute('UPDATE password_reset_tokens SET used_at = NOW() WHERE id = ?', [reset.id]);
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
    payment_method_options: {
      card: {
        installments: { enabled: mode === 'credit' }
      }
    },
    shipping: {
      name: shipping.address.name ?? 'Cliente El Faraón',
      phone: shipping.address.phone,
      address: { line1: shipping.address.line1 ?? '', city: shipping.address.city ?? '', state: shipping.address.state ?? '', postal_code: shipping.address.postalCode ?? '', country: 'MX' }
    },
    metadata: { paymentMode: mode, installmentMonths: String(installmentMonths ?? ''), deliveryMethod: shipping.method, shippingZone: shipping.zone, shippingAmountMxn: String(shipping.amountMxn) }
  });

  response.json({
    ok: true,
    clientSecret: paymentIntent.client_secret,
    paymentIntentId: paymentIntent.id,
    amount: amount / 100,
    message: mode === 'credit' ? 'Stripe mostrará los meses disponibles para tu tarjeta.' : 'Pago contado listo para confirmar con tarjeta.'
  });
});

app.post('/api/orders', async (request, response) => {
  const { stripePaymentIntentId, paymentMode, installmentMonths, amountMxn, items, shipping: shippingRequest } = request.body as { stripePaymentIntentId?: string; paymentMode?: 'cash' | 'credit'; installmentMonths?: 3 | 6 | null; amountMxn?: number; items?: Array<{ productId?: string; quantity?: number }>; shipping?: ShippingRequest };
  if (!db) {
    response.status(503).json({ ok: false, code: 'DATABASE_NOT_CONFIGURED', message: 'El pago fue recibido, pero MySQL todavía no está configurado para guardar el pedido.' });
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
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const [orderResult] = await connection.execute<mysql.ResultSetHeader>('INSERT INTO orders (stripe_payment_intent_id, payment_mode, amount_mxn, shipping_amount_mxn, delivery_method, shipping_zone, recipient_name, recipient_phone, address_line, city, state, postal_code, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [stripePaymentIntentId, paymentMode, Number(amountMxn ?? paymentIntent.amount / 100), shipping.amountMxn, shipping.method, shipping.zone, shipping.address.name ?? '', shipping.address.phone ?? '', shipping.address.line1 ?? '', shipping.address.city ?? '', shipping.address.state ?? '', shipping.address.postalCode ?? '', 'paid']);
    for (const item of items) {
      const product = item.productId ? catalogPrices[item.productId] : undefined;
      if (!product) throw new Error('PRODUCT_UNAVAILABLE');
      const quantity = Math.max(1, Math.min(Number(item.quantity ?? 1), 20));
      if (quantity > (catalogStock[item.productId as string] ?? 0)) throw new Error('INSUFFICIENT_STOCK');
      await connection.execute('INSERT INTO order_items (order_id, product_id, quantity, unit_amount_mxn) VALUES (?, ?, ?, ?)', [orderResult.insertId, item.productId as string, quantity, paymentMode === 'cash' ? product.cash : product.credit]);
    }
    await connection.commit();
    for (const item of items) {
      const productId = item.productId as string;
      catalogStock[productId] -= Math.max(1, Math.min(Number(item.quantity ?? 1), 20));
    }
    response.status(201).json({ ok: true, orderId: orderResult.insertId, message: 'Pedido registrado y listo para preparación.' });
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
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
    response.status(503).json({ ok: false, code: 'DATABASE_NOT_CONFIGURED', message: 'MySQL todavía no está configurado.' });
    return;
  }
  const [rows] = await db.execute<mysql.RowDataPacket[]>('SELECT id, stripe_payment_intent_id, payment_mode, amount_mxn, status, delivery_method, shipping_zone, recipient_name, recipient_phone, address_line, city, state, postal_code, carrier, tracking_number, tracking_url, shipping_status, created_at FROM orders ORDER BY created_at DESC LIMIT 100');
  response.json({ ok: true, orders: rows });
});

app.patch('/api/admin/orders/:id/status', requireAdmin, async (request, response) => {
  if (!db) {
    response.status(503).json({ ok: false, code: 'DATABASE_NOT_CONFIGURED', message: 'MySQL todavía no está configurado.' });
    return;
  }
  const { status, carrier, trackingNumber, trackingUrl, shippingStatus } = request.body as { status?: string; carrier?: string; trackingNumber?: string; trackingUrl?: string; shippingStatus?: string };
  const allowedStatuses = new Set(['pending', 'paid', 'preparing', 'shipped', 'out_for_delivery', 'delivered']);
  if (!status || !allowedStatuses.has(status)) {
    response.status(400).json({ ok: false, code: 'ORDER_STATUS_INVALID', message: 'Estado de pedido no válido.' });
    return;
  }
  await db.execute('UPDATE orders SET status = ?, carrier = ?, tracking_number = ?, tracking_url = ?, shipping_status = ? WHERE id = ?', [status, carrier ?? null, trackingNumber ?? null, trackingUrl ?? null, shippingStatus ?? status, Number(request.params.id)]);
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
  console.error(JSON.stringify({
    level: 'error',
    scope: 'api',
    requestId,
    method: request.method,
    path: request.path,
    code: errorCode,
    message: candidate.message ?? 'Unknown error'
  }));

  let message = 'Ocurrió un error inesperado. Inténtalo de nuevo.';
  let status = candidate.statusCode ?? candidate.status ?? 500;
  if (errorCode === 'CORS_ORIGIN_NOT_ALLOWED') {
    message = 'La API rechazó el origen de esta pantalla. Usa http://localhost:4300 o http://127.0.0.1:4300.';
    status = 403;
  } else if (errorCode === 'ER_ACCESS_DENIED_ERROR') {
    message = 'MySQL rechazó las credenciales configuradas.';
    status = 503;
  } else if (errorCode === 'ECONNREFUSED') {
    message = 'No se pudo conectar con MySQL. Confirma que el servicio esté encendido.';
    status = 503;
  } else if (errorCode === 'ER_NO_SUCH_TABLE') {
    message = 'MySQL está conectado, pero faltan tablas. Ejecuta api/schema.sql.';
    status = 503;
  } else if (error instanceof Stripe.errors.StripeError) {
    message = `Stripe: ${candidate.message ?? 'Stripe rechazó la operación.'}`;
    status = 502;
  }

  response.status(status).json({ ok: false, code: errorCode, message, requestId });
});

app.listen(port, () => console.log(`El Faraón API disponible en http://localhost:${port}`));
