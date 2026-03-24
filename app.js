require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Configuration ─────────────────────────────────────────────────────────────
app.use(cors()); // Critical: Allows your Shopify Storefront to request data from this server

// Your personal store profit multiplier (e.g. 2.5 means Sinalite's $10 becomes $25 on your site)
const RETAIL_MARKUP_MULTIPLIER = 2.5; 
const SINALITE_STORE_CODE = 9; // 9 = USA, 6 = Canada

// ─── Token Manager (Security) ───────────────────────────────────────────────
let cachedToken = null;
let tokenExpiresAt = 0;

async function getSinaliteToken() {
  if (cachedToken && Date.now() < tokenExpiresAt) return cachedToken;
  
  const clientId = process.env.SINALITE_CLIENT_ID;
  const clientSecret = process.env.SINALITE_CLIENT_SECRET;

  if (!clientId || !clientSecret) throw new Error('Missing Sinalite credentials');

  const response = await fetch('https://liveapi.sinalite.com/auth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      audience: 'https://apiconnect.sinalite.com',
      grant_type: 'client_credentials',
    }),
  });

  if (!response.ok) throw new Error(`Sinalite auth failed: ${await response.text()}`);

  const data = await response.json();
  if (!data.access_token) throw new Error('No access token returned');

  cachedToken = data.access_token;
  tokenExpiresAt = Date.now() + 3600000; // Recache every 1 hour to be perfectly safe
  
  return cachedToken;
}

// ─── NEW: "Dynamic Carpenter" Proxy Endpoints ─────────────────────────────────

// 1. Fetch live Product Sizes, Coatings, and Options for the Storefront
app.get('/api/product/:id', async (req, res) => {
  try {
    const token = await getSinaliteToken();
    const productId = req.params.id;

    const response = await fetch(`https://liveapi.sinalite.com/product/${productId}/${SINALITE_STORE_CODE}`, {
        headers: { 'Authorization': `Bearer ${token}` }
    });

    if (!response.ok) throw new Error(`Fetch failed: ${response.status}`);
    const data = await response.json();

    // Sends the exact, safe variant list to your Shopify product page
    res.json(data);
  } catch (err) {
    console.error('[Error] fetching product lists:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// 2. Calculate the exact Price + Margin for the Storefront
app.post('/api/price/:id', express.json(), async (req, res) => {
  try {
    const token = await getSinaliteToken();
    const productId = req.params.id;
    const selectedOptions = req.body;  // Sent instantly when customer changes a dropdown on Shopify

    const response = await fetch(`https://liveapi.sinalite.com/price/${productId}/${SINALITE_STORE_CODE}`, {
        method: 'POST',
        headers: { 
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(selectedOptions)
    });

    if (!response.ok) throw new Error(`Price fetch failed: ${response.status}`);
    const apiPriceData = await response.json();

    // SECRET MAGIC: Apply your personal markup here so the customer never sees the true cost
    if (apiPriceData && apiPriceData.price) {
      apiPriceData.retailPrice = (parseFloat(apiPriceData.price) * RETAIL_MARKUP_MULTIPLIER).toFixed(2);
    }
    
    // Sends the boosted price backward to the user's browser
    res.json(apiPriceData);
  } catch (err) {
    console.error('[Error] calculating price:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Webhook Order Receiver (The Mailman) ────────────────────────────────────

function verifyShopifyWebhook(req, res, next) {
  const hmacHeader = req.headers['x-shopify-hmac-sha256'];
  if (!hmacHeader) return res.status(401).json({ error: 'Missing HMAC header' });

  const secret = process.env.SHOPIFY_WEBHOOK_SECRET;
  if (!secret) return res.status(500).json({ error: 'Server misconfiguration' });

  const generatedHmac = crypto.createHmac('sha256', secret).update(req.body).digest('base64');
  const trusted = Buffer.from(generatedHmac, 'base64');
  const received = Buffer.from(hmacHeader, 'base64');

  if (trusted.length !== received.length || !crypto.timingSafeEqual(trusted, received)) {
    return res.status(401).json({ error: 'Invalid HMAC signature' });
  }

  try { req.orderData = JSON.parse(req.body.toString('utf8')); } 
  catch (err) { return res.status(400).json({ error: 'Invalid JSON payload' }); }
  next();
}

async function sendOrderToSinalite(orderData, accessToken) {
  try {
    const lineItem = orderData.line_items[0];
    const shippingAddress = orderData.shipping_address;

    if (!lineItem) return console.error('[Sinalite] No line items');
    if (!shippingAddress) return console.error('[Sinalite] No shipping address');

    const propertiesMap = {};
    if (Array.isArray(lineItem.properties)) {
      for (const prop of lineItem.properties) propertiesMap[prop.name] = prop.value;
    }

    const fileUrl = propertiesMap['File'];
    if (!fileUrl) return console.error('[Sinalite] No "File" uploaded');

    const shippingInfo = {
      ShipFName: shippingAddress.first_name,
      ShipLName: shippingAddress.last_name,
      ShipAddr: shippingAddress.address1,
      ShipCity: shippingAddress.city,
      ShipState: shippingAddress.province_code,
      ShipZip: shippingAddress.zip,
      ShipCountry: shippingAddress.country_code,
    };

    const options = { ...propertiesMap };
    delete options['File'];

    const items = [{
      productId: lineItem.sku, // Mapped to Sinalite's Base Product ID!
      quantity: lineItem.quantity,
      options,
      files: [{ type: 'front', url: fileUrl }],
    }];

    const payload = {
      referenceId: String(orderData.id),
      shippingInfo,
      items,
    };

    const response = await fetch('https://liveapi.sinalite.com/order/new', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`,
      },
      body: JSON.stringify(payload),
    });

    const responseData = await response.json();
    if (!response.ok) return console.error(`[Sinalite] Order failed:`, responseData);
    
    console.log(`✅ Order #${orderData.order_number} submitted! ID: ${responseData.orderId ?? 'N/A'}`);
  } catch (err) {
    console.error(`Unexpected error submitting order:`, err.message);
  }
}

app.post('/api/webhooks/orders/paid', express.raw({ type: 'application/json' }), verifyShopifyWebhook, (req, res) => {
  res.sendStatus(200); // Shopify expects 200 OK instantly!
  getSinaliteToken().then(token => sendOrderToSinalite(req.orderData, token)).catch(err => console.error(err));
});

// ─── Start Server ─────────────────────────────────────────────────────────────
app.listen(PORT, () => console.log(`🚀 Ultimate Shopify-Sinalite Sync Engine running on port ${PORT}`));
