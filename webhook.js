// webhook.js (legacy file, safe no-op)
// Only used if you do: app.use("/webhooks", require("./webhook"))
// If index.js handles /webhooks/whop directly, you can delete this file.

const express = require("express");
const router = express.Router();

router.post("/whop", express.raw({ type: "application/json" }), (req, res) => {
  console.log("⚠️ webhook.js hit (legacy). index.js should handle /webhooks/whop instead.");
  return res.status(200).send("ok");
});

module.exports = router;
