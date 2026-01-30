const express = require('express');

const router = express.Router();

// IMPORTANT: use raw body for Whop (needed for signature verification later)
router.post(
  '/whop',
  express.raw({ type: '*/*' }),
  (req, res) => {
    try {
      const payload = req.body.toString();
      console.log('📩 Whop webhook received');
      console.log(payload);

      // TODO later:
      // 1) Verify webhook signature
      // 2) Parse event
      // 3) Increment referrals

      res.sendStatus(200);
    } catch (err) {
      console.error('❌ Whop webhook error:', err);
      res.sendStatus(400);
    }
  }
);

module.exports = router;
