# El Faraón API

API mínima para contacto, autenticación, recuperación de contraseña y Stripe Checkout.

1. Copia `.env.example` a `.env` y configura las variables del servidor.
2. Ejecuta `schema.sql` en MySQL.
3. Instala dependencias con `npm install`.
4. Arranca en desarrollo con `npm run dev`.

La clave secreta de Stripe y la de Resend solo se leen en el servidor. Nunca deben llegar al bundle Angular ni al navegador.
