import express from "express";
import jwt from "jsonwebtoken";
import { auth, firestore, stripe, resend, jwtSecret, senderEmail, subscriptionPriceId } from "../config.js";

const router = express.Router();

// ----- COUPONS ROUTES -----
router.get("/coupons", async (req, res) => {
  try {
    const coupons = await stripe.coupons.list({ limit: 100 });
    return res.status(200).json(coupons.data);
  } catch (error) {
    console.error("Error fetching coupons:", error);
    return res.status(500).json([]);
  }
});

router.post("/coupons", async (req, res) => {
  try {
    const { name, domain, discountPercent, maxSeats, expiresAt } = req.body;

    // Convert date string to Unix timestamp (seconds)
    const redeemBy = expiresAt
      ? Math.floor(new Date(expiresAt).getTime() / 1000)
      : undefined;

    const coupon = await stripe.coupons.create({
      percent_off: Number(discountPercent),
      duration: "forever",
      max_redemptions: Number(maxSeats),
      redeem_by: redeemBy,
      name: name,
      metadata: {
        allowed_domain: domain,
      },
    });

    return res.status(201).json(coupon);
  } catch (error) {
    console.error("Error creating coupon:", error);
    return res.status(500).json({ error: error.message });
  }
});

router.post("/manual-override-coupons", async (req, res) => {
  try {
    const { name, email, discountPercent, expiresAt } = req.body;

    // Convert date string to Unix timestamp (seconds)
    const redeemBy = expiresAt
      ? Math.floor(new Date(expiresAt).getTime() / 1000)
      : undefined;

    const coupon = await stripe.coupons.create({
      percent_off: Number(discountPercent),
      duration: "forever",
      max_redemptions: 1,
      redeem_by: redeemBy,
      name: name,
      metadata: {
        allowed_email: email,
      },
    });

    // Send email to the target email
    try {
      const loginUrl = `${process.env.FRONTEND_URL}/login`;
      const signupUrl = `${process.env.FRONTEND_URL}/signup`;
      const expirationText = redeemBy
        ? `This coupon expires on ${new Date(
          redeemBy * 1000
        ).toLocaleDateString()}.`
        : "This coupon never expires.";

      const htmlContent = `
        <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto;">
          <!-- Header with Logo -->
          <div style="background-color: #ffffff; border-bottom: 2px solid #e5e7eb; margin-bottom: 30px;">
            <div style="text-align: center;">
              <img src="${process.env.FRONTEND_URL}/email-logo.png" alt="Pipeline Logo" style="height: 90px; width: auto;" />
            </div>
          </div>
          
          <!-- Email Content -->
          <div style="padding: 0 20px;">
            <p>Hello,</p>
            <p>Great news! You've been granted a special discount coupon for Pipeline.</p>
            
            <div style="background-color: #f3f4f6; border-left: 4px solid #2563eb; padding: 15px; margin: 20px 0;">
              <p style="margin: 0; font-size: 16px;"><strong>Coupon Details:</strong></p>
              <p style="margin: 5px 0;"><strong>Coupon Name:</strong> ${name}</p>
              <p style="margin: 5px 0;"><strong>Discount:</strong> ${discountPercent}% off</p>
              <p style="margin: 5px 0;"><strong>Expiration:</strong> ${expirationText}</p>
            </div>

            <p>This coupon will be automatically applied when you sign up or subscribe using your email address: <strong>${email}</strong>.</p>
            
            <p>To get started:</p>
            <ol style="padding-left: 20px;">
              <li>If you already have an account, <a href="${loginUrl}" style="color: #2563eb;">log in here</a></li>
              <li>If you're new to Pipeline, <a href="${signupUrl}" style="color: #2563eb;">sign up here</a></li>
            </ol>

            <div style="text-align: center; margin: 30px 0;">
              <a href="${signupUrl}" style="display: inline-block; padding: 12px 24px; background-color: #2563eb; color: #ffffff; text-decoration: none; border-radius: 6px; font-weight: bold;">Get Started</a>
            </div>

            <p style="font-size: 12px; color: #666; margin-top: 30px;">If you have any questions, please don't hesitate to contact us.</p>
          </div>
        </div>
      `;

      await resend.emails.send({
        from: senderEmail,
        to: email,
        subject: `Your ${discountPercent}% Discount Coupon for Pipeline`,
        html: htmlContent,
      });

      console.log(`Coupon email sent successfully to ${email}`);
    } catch (emailError) {
      console.error("Error sending coupon email:", emailError);
      // Don't fail the request if email fails, just log it
    }

    return res.status(201).json(coupon);
  } catch (error) {
    console.error("Error creating manual override coupon:", error);
    return res.status(500).json({ error: error.message });
  }
});

router.delete("/coupons/:couponId", async (req, res) => {
  try {
    const { couponId } = req.params;

    await stripe.coupons.del(couponId);

    return res.status(200).json({ message: "Coupon deleted successfully" });
  } catch (error) {
    console.error("Error deleting coupon:", error);
    return res.status(500).json({ error: error.message });
  }
});

router.get("/coupons/check-expiring", async (req, res) => {
  try {
    // Verify cron secret
    const authHeader = req.headers.authorization;
    if (!cronSecret || !authHeader || authHeader !== `Bearer ${cronSecret}`) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    if (!adminEmail) {
      return res.status(500).json({ error: "ADMIN_EMAIL is not configured" });
    }

    const coupons = await stripe.coupons.list({ limit: 100 });
    const now = Math.floor(Date.now() / 1000); // Current time in Unix seconds
    const oneDayInSeconds = 24 * 60 * 60;
    const alertThresholds = [30, 14, 7]; // Days before expiry to alert
    const alertsSent = [];

    for (const coupon of coupons.data) {
      // Skip coupons without an expiry date
      if (!coupon.redeem_by) continue;

      const secondsRemaining = coupon.redeem_by - now;
      const daysRemaining = Math.round(secondsRemaining / oneDayInSeconds);

      // Check if daysRemaining matches any threshold (±1 day tolerance for daily cron)
      const matchedThreshold = alertThresholds.find(
        (threshold) => Math.abs(daysRemaining - threshold) <= 1
      );

      if (matchedThreshold && daysRemaining > 0) {
        const expiryDate = new Date(coupon.redeem_by * 1000).toLocaleDateString(
          "en-US",
          { year: "numeric", month: "long", day: "numeric" }
        );
        const couponTarget =
          coupon.metadata?.allowed_domain ||
          coupon.metadata?.allowed_email ||
          "N/A";
        const targetLabel = coupon.metadata?.allowed_domain
          ? "Domain"
          : "Email";

        const htmlContent = `
          <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto;">
            <div style="background-color: #ffffff; border-bottom: 2px solid #e5e7eb; margin-bottom: 30px;">
              <div style="text-align: center;">
                <img src="${process.env.FRONTEND_URL}/email-logo.png" alt="Pipeline Logo" style="height: 90px; width: auto;" />
              </div>
            </div>
            <div style="padding: 0 20px;">
              <h2 style="color: #d97706;">⚠️ Coupon Expiring Soon</h2>
              <p>The following coupon will expire in <strong>${daysRemaining} day${daysRemaining !== 1 ? "s" : ""}</strong>:</p>
              <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
                <tr style="border-bottom: 1px solid #e5e7eb;">
                  <td style="padding: 8px 0; font-weight: bold; color: #555;">Coupon Name</td>
                  <td style="padding: 8px 0;">${coupon.name || coupon.id}</td>
                </tr>
                <tr style="border-bottom: 1px solid #e5e7eb;">
                  <td style="padding: 8px 0; font-weight: bold; color: #555;">${targetLabel}</td>
                  <td style="padding: 8px 0;">${couponTarget}</td>
                </tr>
                <tr style="border-bottom: 1px solid #e5e7eb;">
                  <td style="padding: 8px 0; font-weight: bold; color: #555;">Discount</td>
                  <td style="padding: 8px 0;">${coupon.percent_off}% off</td>
                </tr>
                <tr style="border-bottom: 1px solid #e5e7eb;">
                  <td style="padding: 8px 0; font-weight: bold; color: #555;">Expiry Date</td>
                  <td style="padding: 8px 0;">${expiryDate}</td>
                </tr>
                <tr style="border-bottom: 1px solid #e5e7eb;">
                  <td style="padding: 8px 0; font-weight: bold; color: #555;">Redemptions</td>
                  <td style="padding: 8px 0;">${coupon.times_redeemed}${coupon.max_redemptions ? " / " + coupon.max_redemptions : ""}</td>
                </tr>
              </table>
              <p style="font-size: 13px; color: #666;">This is an automated alert. Please take action if needed before the expiry date.</p>
            </div>
          </div>
        `;

        await resend.emails.send({
          from: senderEmail,
          to: adminEmail,
          subject: `⚠️ Coupon "${coupon.name || coupon.id}" expires in ${daysRemaining} days`,
          html: htmlContent,
        });

        alertsSent.push({
          coupon: coupon.name || coupon.id,
          daysRemaining,
          expiryDate,
        });
      }
    }

    return res.status(200).json({
      message: `Processed ${coupons.data.length} coupons, sent ${alertsSent.length} alert(s)`,
      alerts: alertsSent,
    });
  } catch (error) {
    console.error("Error checking expiring coupons:", error);
    return res.status(500).json({ error: "Failed to check expiring coupons" });
  }
});

router.post("/coupons/bulk", async (req, res) => {
  try {
    const { coupons } = req.body;

    if (!Array.isArray(coupons) || coupons.length === 0) {
      return res.status(400).json({
        error: "Please provide an array of coupons",
      });
    }

    let created = 0;
    let failed = 0;
    const errors = [];

    for (let i = 0; i < coupons.length; i++) {
      const coupon = coupons[i];
      try {
        // Convert date string to Unix timestamp (seconds)
        const redeemBy = coupon.expiresAt
          ? Math.floor(new Date(coupon.expiresAt).getTime() / 1000)
          : undefined;

        if (coupon.type === "domain") {
          // Create domain coupon
          await stripe.coupons.create({
            percent_off: Number(coupon.discountPercent),
            duration: "forever",
            max_redemptions: Number(coupon.maxSeats),
            redeem_by: redeemBy,
            name: coupon.name,
            metadata: {
              allowed_domain: coupon.domain,
            },
          });
          created++;
        } else if (coupon.type === "email") {
          // Create email coupon
          await stripe.coupons.create({
            percent_off: Number(coupon.discountPercent),
            duration: "forever",
            max_redemptions: 1,
            redeem_by: redeemBy,
            name: coupon.name,
            metadata: {
              allowed_email: coupon.email,
            },
          });
          created++;
        } else {
          throw new Error(`Invalid coupon type: ${coupon.type}`);
        }
      } catch (error) {
        failed++;
        errors.push({
          row: i + 1,
          coupon: coupon.name || `Row ${i + 1}`,
          error: error.message,
        });
        console.error(`Error creating coupon at row ${i + 1}:`, error);
      }
    }

    return res.status(200).json({
      created,
      failed,
      total: coupons.length,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (error) {
    console.error("Error creating bulk coupons:", error);
    return res.status(500).json({ error: error.message });
  }
});

router.post("/discounts", async (req, res) => {
  const { email } = req.body;
  const emailDomain = email.split("@")[1];
  const coupons = await stripe.coupons.list({ limit: 100 });

  const discount = getDiscount(coupons.data, email, emailDomain);

  if (!discount || discount.max_redemptions === discount.times_redeemed) {
    return res.status(200).json({ discount: null });
  }

  return res.status(200).json({
    discount: {
      discount: discount.percent_off / 100,
      domain: discount.metadata.allowed_domain,
    },
  });
});

// -------- HELPER FUNCTION -----------
export function getDiscount(coupons, email, domain) {
  const currentTime = Math.floor(Date.now() / 1000); // Current Unix timestamp in seconds

  // Helper function to check if coupon is valid (not expired and not fully redeemed)
  const isValidCoupon = (coupon) => {
    // Check if coupon is expired
    if (coupon.redeem_by && coupon.redeem_by < currentTime) {
      return false;
    }
    // Check if coupon has reached max redemptions
    if (
      coupon.max_redemptions &&
      coupon.times_redeemed >= coupon.max_redemptions
    ) {
      return false;
    }
    return true;
  };

  // 1. Filter email and domain coupons, excluding expired and fully redeemed ones
  const emailCoupons = coupons.filter(
    (c) => c.metadata.allowed_email === email && isValidCoupon(c)
  );
  const domainCoupons = coupons.filter(
    (c) => c.metadata.allowed_domain === domain && isValidCoupon(c)
  );

  // 2. If user have an email coupon return it
  //    otherwise, check for a domain based coupon
  const emailDiscount = emailCoupons.find(
    (c) => c.metadata.allowed_email === email
  );
  if (emailDiscount) {
    return emailDiscount;
  }

  const domainDiscount = domainCoupons.find(
    (c) => c.metadata.allowed_domain === domain
  );
  if (domainDiscount) {
    return domainDiscount;
  }

  // 3. If no discounts are available, return null (fallback to normal price)
  return null;
}

export default router;
