import express from "express";
import cors from "cors";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import dotenv from "dotenv";
import userRoutes from "./routes/user.routes.js";
import adminRoutes from "./routes/admin.routes.js";
import stripeRoutes from "./routes/stripe.routes.js";
import institutionRoutes from "./routes/institution.routes.js";
import couponRoutes from "./routes/coupon.routes.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config({ path: join(__dirname, ".env") });

// App config
const app = express();
app.use(express.json());
app.use(
  cors({
    origin: process.env.FRONTEND_URL,
  })
);

// Register routes
app.use("/", userRoutes);
app.use("/", adminRoutes);
app.use("/", stripeRoutes);
app.use("/", institutionRoutes);
app.use("/", couponRoutes);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});

// Export for serverless (like Vercel)
export default app;
