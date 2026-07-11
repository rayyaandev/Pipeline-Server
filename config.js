import { Resend } from "resend";
import Stripe from "stripe";
import { cert, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import dotenv from "dotenv";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config({ path: join(__dirname, ".env") });

const resendApiKey = process.env.RESEND_API_KEY;
const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
export const senderEmail = process.env.SENDER_EMAIL;
const firebaseServiceAccount = process.env.FIREBASE_SERVICE_ACCOUNT;
export const jwtSecret = process.env.JWT_SECRET;
const nodeEnv = process.env.NODE_ENV;
export const adminEmail = process.env.ADMIN_EMAIL;
export const cronSecret = process.env.CRON_SECRET;

export const subscriptionPriceId =
  nodeEnv === "production"
    ? process.env.SUBSCRIPTION_PRICE_ID
    : "price_1SVczaFG6H6jDaisbaA2rmbz";

if (!subscriptionPriceId) {
  throw new Error("Please define SUBSCRIPTION_PRICE_ID in .env");
}

if (!firebaseServiceAccount) {
  throw new Error("Please define FIREBASE_SERVICE_ACCOUNT in .env");
}
if (!resendApiKey) {
  throw new Error("Please define RESEND_API_KEY in .env");
}
if (!senderEmail) {
  throw new Error("Please define SENDER_EMAIL in .env");
}
if (!stripeSecretKey) {
  throw new Error("Please define STRIPE_SECRET_KEY in .env");
}
if (!jwtSecret) {
  throw new Error("Please define JWT_SECRET in .env");
}

export const resend = new Resend(resendApiKey);
export const stripe = new Stripe(stripeSecretKey, {
  timeout: 30000, // 30 second timeout to prevent hanging on stale connections
});
const firebaseApp = initializeApp({
  credential: cert(JSON.parse(firebaseServiceAccount)),
});
export const auth = getAuth(firebaseApp);
export const firestore = getFirestore(firebaseApp);
