require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Configuration ─────────────────────────────────────────────────────────────
app.use(cors()); // Critical: Allows your Shopify Storefront to request data from this server

// Your personal store profit multiplier (e.g. 2.5 means Sinalite's $10 becomes $25 on your site)
const RETAIL_MARKUP_MULTIPLIER = 2.25; 
const SINALITE_STORE_CODE = 9; // 9 = USA, 6 = Canada

// ─── Token Manager (Security) ───────────────────────────────────────────────
let cachedToken = null;
let tokenExpiresAt = 0;

async function getSinaliteToken() {
  if (cachedToken && Date.now() < tokenExpiresAt) return cachedToken;
  
  const clientId = process.env.SINALITE_CLIENT_ID;
  const clientSecret = process.env.SINALITE_CLIENT_SECRET;

  if (!clientId || !clientSecret) throw new Error('Missing Sinalite credentials');

  const response = await fetch('https://api.sinaliteuppy.com/auth/token', {
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

    const response = await fetch(`https://api.sinaliteuppy.com/product/${productId}/${SINALITE_STORE_CODE}`, {
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

    const response = await fetch(`https://api.sinaliteuppy.com/price/${productId}/${SINALITE_STORE_CODE}`, {
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

// 3. Create a Custom Checkout (Draft Order Teleport!)
app.post('/api/checkout/:id', express.json(), async (req, res) => {
  try {
    // 1. Get exact price from Sinalite
    const sinaliteToken = await getSinaliteToken();
    const productId = req.params.id;
    
    // The payload sent from Shopify Script contains the IDs and the visual Labels
    const selectedOptions = { productOptions: req.body.productOptions }; 

    const priceResponse = await fetch(`https://api.sinaliteuppy.com/price/${productId}/${SINALITE_STORE_CODE}`, {
        method: 'POST',
        headers: { 
          'Authorization': `Bearer ${sinaliteToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(selectedOptions)
    });

    if (!priceResponse.ok) throw new Error(`[Sinalite] Price fetch failed: ${priceResponse.status}`);
    const apiPriceData = await priceResponse.json();
    
    if (!apiPriceData || !apiPriceData.price) throw new Error('Could not calculate price.');
    const retailPrice = (parseFloat(apiPriceData.price) * RETAIL_MARKUP_MULTIPLIER).toFixed(2);

    // 2. Authenticate with Shopify Dev Dashboard magically
    const shopifyDomain = process.env.SHOPIFY_STORE_DOMAIN;
    const shopifyClientId = process.env.SHOPIFY_CLIENT_ID;
    const shopifyClientSecret = process.env.SHOPIFY_CLIENT_SECRET;

    if (!shopifyDomain || !shopifyClientId || !shopifyClientSecret) {
       throw new Error('Missing Shopify Dev Dashboard Credentials in Render Environment Variables');
    }

    const shopAuthReq = await fetch(`https://${shopifyDomain}/admin/oauth/access_token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            client_id: shopifyClientId,
            client_secret: shopifyClientSecret,
            grant_type: "client_credentials"
        })
    });

    if (!shopAuthReq.ok) throw new Error(`[Shopify Auth] Failed: ${await shopAuthReq.text()}`);
    const shopAuthData = await shopAuthReq.json();
    const shopifyToken = shopAuthData.access_token;

    // 3. Create Draft Order in Shopify natively!
    const draftOrderPayload = {
      draft_order: {
        line_items: [
          {
            title: `Custom Print Job (ID: ${productId})`,
            price: retailPrice,
            quantity: 1,
            properties: req.body.optionNames || [] // Appends the visual size/coating choices to the cart!
          }
        ],
        taxes_included: false
      }
    };

    const draftRes = await fetch(`https://${shopifyDomain}/admin/api/2024-01/draft_orders.json`, {
      method: 'POST',
      headers: {
         'Content-Type': 'application/json',
         'X-Shopify-Access-Token': shopifyToken
      },
      body: JSON.stringify(draftOrderPayload)
    });

    if (!draftRes.ok) throw new Error(`[Shopify Draft] Failed: ${await draftRes.text()}`);
    const draftData = await draftRes.json();

    // 4. Return the magic checkout URL!
    res.json({ checkoutUrl: draftData.draft_order.invoice_url });

  } catch (err) {
    console.error('[Error] creating checkout:', err.message);
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
    const lineItems = orderData.line_items;
    const shippingAddress = orderData.shipping_address;

    if (!lineItems || lineItems.length === 0) return console.error('[Sinalite] No line items');
    if (!shippingAddress) return console.error('[Sinalite] No shipping address');

    // ── Merge ALL properties from ALL line items into one map ──────────────────
    // Why: Optis app splits the order into two line items:
    //   F1 (Pricing Unit) → has size, material, coating, etc.
    //   F2 (Base Product) → has the SKU, file upload URL, and add-on options
    const propertiesMap = {};
    let sinaliteProductId = null;
    let totalQuantity = 1;

    for (const item of lineItems) {
      // Grab the Sinalite Base Product SKU from whichever line item has one
      if (item.sku && !sinaliteProductId) {
        sinaliteProductId = item.sku;
        totalQuantity = item.quantity;
      }
      // Merge all properties
      if (Array.isArray(item.properties)) {
        for (const prop of item.properties) propertiesMap[prop.name] = prop.value;
      }
    }

    if (!sinaliteProductId) return console.error('[Sinalite] No SKU found on any line item — cannot identify Sinalite product');

    // ── Find file URL across all known property name variants ─────────────────
    const fileUrl = propertiesMap['File'] 
                 || propertiesMap['file upload 1'] 
                 || propertiesMap['file_upload'];
    if (!fileUrl) return console.error('[Sinalite] No "File" uploaded — order blocked to prevent blank print');

    // ── Build shipping info ───────────────────────────────────────────────────
    const shippingInfo = {
      ShipFName: shippingAddress.first_name,
      ShipLName: shippingAddress.last_name,
      ShipAddr: shippingAddress.address1,
      ShipCity: shippingAddress.city,
      ShipState: shippingAddress.province_code,
      ShipZip: shippingAddress.zip,
      ShipCountry: shippingAddress.country_code,
    };

    // Use shipping address as billing (Shopify doesn't always expose billing separately)
    const billingInfo = {
      BillFName: shippingAddress.first_name,
      BillLName: shippingAddress.last_name,
      BillAddr: shippingAddress.address1,
      BillCity: shippingAddress.city,
      BillState: shippingAddress.province_code,
      BillZip: shippingAddress.zip,
      BillCountry: shippingAddress.country_code,
    };

    // ── Build options: remove file URL keys so they don't become print options ─
    const options = { ...propertiesMap };
    delete options['File'];
    delete options['file upload 1'];
    delete options['file_upload'];
    // Also strip Optis add-on labels (not real print options for Sinalite)
    delete options['Get email proof(+$5)'];
    delete options['Need Design Services (+$59.99)'];

    const items = [{
      productId: sinaliteProductId, // Sinalite Base Product ID (e.g. "30" for Business Cards 18pt)
      quantity: totalQuantity,
      options,
      files: [{ type: 'front', url: fileUrl }],
    }];

    const payload = {
      referenceId: String(orderData.id),
      shippingInfo,
      billingInfo,
      items,
    };

    console.log(`[Sinalite] Submitting order #${orderData.order_number} — Product: ${sinaliteProductId}, File: ${fileUrl}`);

    const response = await fetch('https://api.sinaliteuppy.com/order/new', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`,
      },
      body: JSON.stringify(payload),
    });

    const rawText = await response.text();
    let responseData;
    try { responseData = JSON.parse(rawText); } catch { responseData = rawText; }
    if (!response.ok) return console.error(`[Sinalite] Order failed (${response.status}):`, responseData);
    
    console.log(`✅ Order #${orderData.order_number} submitted! Sinalite ID: ${responseData.orderId ?? 'N/A'}`);
  } catch (err) {
    console.error(`Unexpected error submitting order:`, err.message);
  }
}

app.post('/api/webhooks/orders/paid', express.raw({ type: 'application/json' }), verifyShopifyWebhook, (req, res) => {
  res.sendStatus(200); // Shopify expects 200 OK instantly!
  getSinaliteToken().then(token => sendOrderToSinalite(req.orderData, token)).catch(err => console.error(err));
});

// ─── Manual Order Rescue Endpoint (Temporary) ─────────────────────────────────
// Use this to re-submit past orders that the webhook missed.
// Call via: GET https://shopify-sinalite-app.onrender.com/api/manual-submit/:orderId?secret=pixilab2026
app.get('/api/manual-submit/:orderId', async (req, res) => {
  // Basic secret gate so this can't be abused
  if (req.query.secret !== 'pixilab2026') {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const orderId = req.params.orderId;
  console.log(`[Manual] Triggered for Shopify Order ID: ${orderId}`);
  
  try {
    // 1. Fetch the order from Shopify Admin API
    const shopifyDomain = process.env.SHOPIFY_STORE_DOMAIN;
    // SHOPIFY_ADMIN_TOKEN = the shpat_... token from Shopify Admin > Apps > Develop apps > API credentials
    const shopifyToken = process.env.SHOPIFY_ADMIN_TOKEN;
    if (!shopifyToken) return res.status(500).json({ error: 'Missing SHOPIFY_ADMIN_TOKEN env var — see INTEGRATION_MASTER_GUIDE.md' });

    const orderRes = await fetch(`https://${shopifyDomain}/admin/api/2024-01/orders/${orderId}.json`, {
      headers: { 'X-Shopify-Access-Token': shopifyToken }
    });

    if (!orderRes.ok) {
      const err = await orderRes.text();
      console.error(`[Manual] Shopify fetch failed: ${err}`);
      return res.status(500).json({ error: `Shopify fetch failed: ${err}` });
    }

    const { order } = await orderRes.json();
    console.log(`[Manual] Fetched order #${order.order_number} with ${order.line_items.length} line items`);
    
    // Log all properties for debugging
    for (const item of order.line_items) {
      console.log(`[Manual] Line item: "${item.title}" | SKU: "${item.sku}" | Props: ${JSON.stringify(item.properties)}`);
    }

    // 2. Submit to Sinalite using the same shared function
    const token = await getSinaliteToken();
    await sendOrderToSinalite(order, token);

    res.json({ 
      success: true, 
      message: `Order #${order.order_number} submitted to Sinalite. Check Render logs for result.` 
    });

  } catch (err) {
    console.error('[Manual] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── ONE-TIME RESCUE: Order #PDS-1003 (Ayaan Lakhani) ────────────────────────
// All data hardcoded from Shopify order screenshots — no admin token needed.
// Call via: GET https://shopify-sinalite-app.onrender.com/api/rescue-pds1003?secret=pixilab2026
app.get('/api/rescue-pds1003', async (req, res) => {
  if (req.query.secret !== 'pixilab2026') return res.status(403).json({ error: 'Forbidden' });

  try {
    const token = await getSinaliteToken();

    const payload = {
      referenceId: '7929734266942-R1', // Unique suffix added to avoid duplicate rejection
      shippingInfo: {
        ShipFName: 'Ayaan',
        ShipLName: 'Lakhani',
        ShipAddr: '405 Darlene Trl',
        ShipCity: 'Euless',
        ShipState: 'TX',
        ShipZip: '76039',
        ShipCountry: 'US',
      },
      billingInfo: {
        BillFName: 'Ayaan',
        BillLName: 'Lakhani',
        BillAddr: '405 Darlene Trl',
        BillCity: 'Euless',
        BillState: 'TX',
        BillZip: '76039',
        BillCountry: 'US',
      },
      items: [{
        productId: '30', // Sinalite Base Product ID (Business Cards 18pt Matte Lam + SPOT UV)
        quantity: 500,
        options: {
          'Card Stock (Material)': '16PT Printed 2 Sides (4/4)',
          'Size': '3.5x2',
          'Coating (Lamination/Finish)': 'Soft Touch Lamination 2 Sided',
          'Round Corners': 'No',
          'Spot UV': 'Two sided',
          'Turnaround Period (Production time)': '4 - 5 Business Days',
        },
        files: [{
          type: 'front',
          url: 'https://production-options-bucket.s3.us-east-2.amazonaws.com/po/pixilabb.myshopify.com-45104/1775518543916-421439935-pixilprintbc.pdf'
        }],
      }],
    };

    console.log('[Rescue PDS-1003] Submitting to Sinalite...');
    console.log('[Rescue PDS-1003] Payload:', JSON.stringify(payload, null, 2));

    const response = await fetch('https://api.sinaliteuppy.com/order/new', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
    });

    const rawText = await response.text();
    let responseData;
    try { responseData = JSON.parse(rawText); } catch { responseData = rawText; }

    console.log(`[Rescue PDS-1003] Sinalite HTTP ${response.status} response:`, responseData);

    if (!response.ok) {
      return res.status(500).json({ error: 'Sinalite rejected order', httpStatus: response.status, details: responseData });
    }

    console.log(`✅ [Rescue PDS-1003] SUCCESS! Sinalite Order ID: ${responseData.orderId ?? 'N/A'}`);
    res.json({
      success: true,
      message: 'Order #PDS-1003 successfully submitted to Sinalite!',
      sinaliteOrderId: responseData.orderId,
      fullResponse: responseData,
    });

  } catch (err) {
    console.error('[Rescue PDS-1003] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Start Server ─────────────────────────────────────────────────────────────
app.listen(PORT, () => console.log(`🚀 Ultimate Shopify-Sinalite Sync Engine running on port ${PORT}`));
