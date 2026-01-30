const express = require('express');
const app = express();

app.use(express.json());

app.post('/webhooks/whop', (req, res) => {
  console.log('📩 Whop event received:', req.body);
  res.sendStatus(200);
});

app.listen(3000, () => {
  console.log('🚀 Webhook listening on port 3000');
});
