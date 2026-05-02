require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Configuration ─────────────────────────────────────────────────────────────
app.use(cors()); // Critical: Allows your Shopify Storefront to request data from this server

// Your personal store profit multiplier (e.g. 2.5 means Sinalite's $10 becomes $25 on your site)
const RETAIL_MARKUP_MULTIPLIER = 3.50; 
const SINALITE_STORE_CODE = 9; // 9 = USA, 6 = Canada

// ✅ PRODUCTION: Switched from staging (api.sinaliteuppy.com) → live (liveapi.sinalite.com)
// To revert to staging: 'https://api.sinaliteuppy.com'
const SINALITE_BASE_URL = 'https://liveapi.sinalite.com';

// ─── Token Manager (Security) ───────────────────────────────────────────────
let cachedToken = null;
let tokenExpiresAt = 0;

async function getSinaliteToken() {
  if (cachedToken && Date.now() < tokenExpiresAt) return cachedToken;
  
  const clientId = process.env.SINALITE_CLIENT_ID;
  const clientSecret = process.env.SINALITE_CLIENT_SECRET;

  if (!clientId || !clientSecret) throw new Error('Missing Sinalite credentials');

  const response = await fetch(`${SINALITE_BASE_URL}/auth/token`, {
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

// ─── Shopify Token Manager (New 2026 Flow) ──────────────────────────────────
let cachedShopifyToken = null;
let shopifyTokenExpiresAt = 0;

async function getShopifyToken() {
  if (cachedShopifyToken && Date.now() < shopifyTokenExpiresAt) return cachedShopifyToken;

  const shopifyDomain = process.env.SHOPIFY_STORE_DOMAIN;
  const clientId = process.env.SHOPIFY_CLIENT_ID;
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET;

  if (!shopifyDomain || !clientId || !clientSecret) {
    throw new Error('Missing Shopify Credentials in Environment Variables');
  }

  const response = await fetch(`https://${shopifyDomain}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'client_credentials',
    }),
  });

  if (!response.ok) throw new Error(`Shopify auth failed: ${await response.text()}`);

  const data = await response.json();
  cachedShopifyToken = data.access_token;
  // Shopify tokens via client_credentials usually don't expire for custom apps, 
  // but we'll recache daily to be safe.
  shopifyTokenExpiresAt = Date.now() + 86400000; 
  
  return cachedShopifyToken;
}


// ─── NEW: "Dynamic Carpenter" Proxy Endpoints ─────────────────────────────────

// 1. Fetch live Product Sizes, Coatings, and Options for the Storefront
app.get('/api/product/:id', async (req, res) => {
  try {
    const token = await getSinaliteToken();
    const productId = req.params.id;

    const response = await fetch(`${SINALITE_BASE_URL}/product/${productId}/${SINALITE_STORE_CODE}`, {
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

    const response = await fetch(`${SINALITE_BASE_URL}/price/${productId}/${SINALITE_STORE_CODE}`, {
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

    const priceResponse = await fetch(`${SINALITE_BASE_URL}/price/${productId}/${SINALITE_STORE_CODE}`, {
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

    // 2. Authenticate with Shopify magically (2026 OAuth Flow)
    const shopifyDomain = process.env.SHOPIFY_STORE_DOMAIN;
    const shopifyToken = await getShopifyToken();


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

// 4. Create a Custom Checkout from the whole CART!
app.post('/api/teleport-cart', express.json(), async (req, res) => {
  try {
    const cartData = req.body; // Full cart JSON from Shopify (with captured note)
    const shopifyDomain = process.env.SHOPIFY_STORE_DOMAIN;
    const shopifyToken = await getShopifyToken();

    if (!cartData || !cartData.items || cartData.items.length === 0) {
      return res.status(400).json({ error: 'Cart is empty' });
    }

    const groupedJobs = {};
    const standaloneItems = [];

    // ── Group items by _job_id ──────────────────────────────────────────────
    cartData.items.forEach(item => {
      const jobId = item.properties ? item.properties._job_id : null;
      
      if (jobId) {
        if (!groupedJobs[jobId]) {
          groupedJobs[jobId] = {
            title: item.product_title,
            total_price_cents: 0,
            quantity: 1, 
            propertiesMap: {} // Use a map to merge properties across all items in the job
          };
        }
        
        // Accumulate ALL properties from ALL items sharing this Job ID
        for (const [key, value] of Object.entries(item.properties)) {
           // 🛠️ FINAL CLEANING: Remap technical names to friendly titles
           let cleanKey = key;
           if (key.startsWith('_') && key !== '_job_id') {
              cleanKey = key.substring(1); 
           }

           // Common remapping for Optis tech-names
           const remapping = {
              "po_text_area": "Instructions",
              "YES": "Service Confirmed",
              "Front": "Front Artwork",
              "Back": "Back Artwork",
              "Specific instructions": "Specific Instructions"
           };

           for (const [tech, friendly] of Object.entries(remapping)) {
              if (cleanKey.includes(tech)) cleanKey = friendly;
           }
           
           // Don't overwrite if already exists (unless current is technical and new is friendly)
           if (!groupedJobs[jobId].propertiesMap[cleanKey] || groupedJobs[jobId].propertiesMap[cleanKey] === "") {
              groupedJobs[jobId].propertiesMap[cleanKey] = value;
           }

           // If this is a "Specific Instruction", promote it to the master Order Note too
           if (cleanKey === "Specific Instructions" || cleanKey === "Instructions") {
              cartData.note = (cartData.note || "") + " | " + value;
           }
        }
        
        groupedJobs[jobId].total_price_cents += (item.price * item.quantity);
      } else {
        // Standard non-Sinalite item
        standaloneItems.push({
          title: item.title,
          price: (item.price / 100).toFixed(2),
          quantity: item.quantity,
          properties: item.properties ? Object.entries(item.properties).map(([k,v]) => ({ 
             name: k.startsWith('_') ? k.substring(1) : k, 
             value: v 
          })) : []
        });
      }
    });

    // ── Build final line items ──────────────────────────────────────────────
    const finalLineItems = [
      ...standaloneItems,
      ...Object.values(groupedJobs).map(job => ({
        title: job.title,
        price: (job.total_price_cents / 100).toFixed(2),
        quantity: job.quantity,
        properties: Object.entries(job.propertiesMap).map(([name, value]) => ({ name, value }))
      }))
    ];

    const draftOrderPayload = {
      draft_order: {
        line_items: finalLineItems,
        taxes_included: false,
        note: cartData.note || "Auto-generated via Pixilab Teleporter"
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

    if (!draftRes.ok) {
       const errorText = await draftRes.text();
       throw new Error(`[Shopify Draft Error] ${errorText}`);
    }

    const draftData = await draftRes.json();
    res.json({ checkoutUrl: draftData.draft_order.invoice_url });

  } catch (err) {
    console.error('[Error] teleport-cart failed:', err.message);
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

    // ── Build shipping/billing info ───────────────────────────────────────────
    const shippingInfo = {
      ShipFName: shippingAddress.first_name,
      ShipLName: shippingAddress.last_name,
      ShipAddr: shippingAddress.address1,
      ShipCity: shippingAddress.city,
      ShipState: shippingAddress.province_code,
      ShipZip: shippingAddress.zip,
      ShipCountry: shippingAddress.country_code,
      ShipEmail: orderData.email || '',
      ShipPhone: shippingAddress.phone || '0000000000',
      ShipMethod: 'UPS Ground',
    };

    const billingInfo = {
      BillFName: shippingAddress.first_name,
      BillLName: shippingAddress.last_name,
      BillAddr: shippingAddress.address1,
      BillCity: shippingAddress.city,
      BillState: shippingAddress.province_code,
      BillZip: shippingAddress.zip,
      BillCountry: shippingAddress.country_code,
      BillEmail: orderData.email || '',
      BillPhone: shippingAddress.phone || '0000000000',
    };

    // ── Fetch Sinalite product option list to map names → numeric IDs ─────────
    // Sinalite requires numeric option IDs, not human-readable labels.
    const productRes = await fetch(`${SINALITE_BASE_URL}/product/${sinaliteProductId}/${SINALITE_STORE_CODE}`, {
      headers: { 'Authorization': `Bearer ${accessToken}` }
    });
    const productRaw = await productRes.text();
    let sinaliteOptions = [];
    try {
      const parsed = JSON.parse(productRaw);
      sinaliteOptions = Array.isArray(parsed[0]) ? parsed[0] : [];
    } catch { /* leave empty */ }

    // ── Map each Shopify property value to Sinalite option ID ─────────────────
    // Cleanup: remove non-print properties before mapping
    const cleanProps = { ...propertiesMap };
    ['File', 'file upload 1', 'file_upload', 'Get email proof(+$5)', 'Need Design Services (+$59.99)', '__bss_po_addons'].forEach(k => delete cleanProps[k]);

    const mappedOptions = {};
    for (const sOpt of sinaliteOptions) {
      const optNameLower = sOpt.name.toLowerCase().trim();
      // Special case: qty — match against the actual line item quantity number
      if (sOpt.group === 'qty' && sOpt.name === String(totalQuantity)) {
        mappedOptions['qty'] = String(sOpt.id);
        continue;
      }
      // General case: match Sinalite option name against any Shopify property value
      for (const propValue of Object.values(cleanProps)) {
        if (optNameLower === propValue.toLowerCase().trim()) {
          mappedOptions[sOpt.group] = String(sOpt.id);
          break;
        }
      }
    }

    console.log(`[Sinalite] Mapped options for product ${sinaliteProductId}:`, mappedOptions);

    const items = [{
      productId: Number(sinaliteProductId),
      options: mappedOptions,
      files: [{ type: 'front', url: fileUrl }],
    }];

    const payload = {
      referenceId: String(orderData.id),
      shippingInfo,
      billingInfo,
      items,
    };

    console.log(`[Sinalite] Submitting order #${orderData.order_number} — Product: ${sinaliteProductId}, File: ${fileUrl}`);

    const response = await fetch(`${SINALITE_BASE_URL}/order/new`, {
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
    const shopifyToken = await getShopifyToken();
    
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

// ─── Start Server ─────────────────────────────────────────────────────────────

// ─── Start Server ─────────────────────────────────────────────────────────────
app.listen(PORT, () => console.log(`🚀 Ultimate Shopify-Sinalite Sync Engine running on port ${PORT}`));
