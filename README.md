# El Faraón API

API para contacto, autenticación, recuperación de contraseña, Stripe y seguimiento de pedidos.

1. Copia `.env.example` a `.env` y configura las variables del servidor.
2. La API aplica `migrations/001_initial.sql` automáticamente al arrancar contra Postgres/Supabase.
3. Instala dependencias con `npm install`.
4. Arranca en desarrollo con `npm run dev`.

Para Vercel, configura este directorio como el proyecto de la API y agrega las variables de `.env.example` en Project Settings. El frontend usa `https://faraon-api.vercel.app` fuera de localhost.

La clave secreta de Stripe y la de Resend solo se leen en el servidor. Nunca deben llegar al bundle Angular ni al navegador.
