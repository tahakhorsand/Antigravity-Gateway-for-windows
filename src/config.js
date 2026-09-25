import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const CONFIG = {
  PORT: process.env.PORT ? parseInt(process.env.PORT, 10) : 8045,
  HOST: '127.0.0.1',
  CLIENT_ID: 'YOUR_CLIENT_ID.apps.googleusercontent.com',
  CLIENT_SECRET: 'YOUR_CLIENT_SECRET',
  TOKEN_ENDPOINT: 'https://oauth2.googleapis.com/token',
  UPSTREAM_BASE_URL: 'https://generativelanguage.googleapis.com',
  ACCOUNTS_FILE: path.resolve(__dirname, '../accounts.json'),
  OAUTH_REDIRECT_URI: 'http://localhost:8085/oauth/callback',
  SCOPES: [
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/userinfo.profile',
    'https://www.googleapis.com/auth/cloud-platform',
    'https://www.googleapis.com/auth/generative-language'
  ]
};
