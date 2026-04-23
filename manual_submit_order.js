/**
 * manual_submit_order.js
 * ────────────────────────────────────────────────────────────────
 * One-time rescue script: fetches a specific Shopify order and
 * submits it to Sinalite manually, bypassing the webhook flow.
 *
 * Usage:
 *   node manual_submit_order.js
 * ────────────────────────────────────────────────────────────────
 */
require('dotenv').config();

// ── CONFIG: Set the Shopify Order ID you want to re-submit ────────
const SHOPIFY_ORDER_ID = '7929734266942'; // #PDS-1003

const RETAIL_MARKUP_MULTIPLIER = 2.25;
const SINALITE_STORE_CODE = 9;

// ── Step 1: Get Sinalite Token ────────────────────────────────────
async function getSinaliteToken() {
  const response = await fetch('https://api.sinaliteuppy.com/auth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: process.env.SINALITE_CLIENT_ID,
      client_secret: process.env.SINALITE_CLIENT_SECRET,
      audience: 'https://apiconnect.sinalite.com',
      grant_type: 'client_credentials',
    }),
  });
  const data = await response.json();
  if (!data.access_token) throw new Error('Sinalite auth failed: ' + JSON.stringify(data));
  console.log('✅ Sinalite token obtained');
  return data.access_token;
}

// ── Step 2: Fetch Order from Shopify ─────────────────────────────
async function fetchShopifyOrder(orderId) {
  const domain = process.env.SHOPIFY_STORE_DOMAIN;
  const token = process.env.SHOPIFY_CLIENT_SECRET; // Admin API access token

  const response = await fetch(
    `https://${domain}/admin/api/2024-01/orders/${orderId}.json`,
    { headers: { 'X-Shopify-Access-Token': token } }
  );

  if (!response.ok) throw new Error(`Shopify fetch failed: ${response.status} ${await response.text()}`);
  const data = await response.json();
  console.log(`✅ Fetched Shopify order #${data.order.order_number} (${data.order.line_items.length} line items)`);
  return data.order;
}

// ── Step 3: Submit to Sinalite ────────────────────────────────────
async function sendOrderToSinalite(orderData, accessToken) {
  const lineItems = orderData.line_items;
  const shippingAddress = orderData.shipping_address;

  if (!lineItems || lineItems.length === 0) throw new Error('No line items on order');
  if (!shippingAddress) throw new Error('No shipping address on order');

  // Merge ALL properties from ALL line items
  const propertiesMap = {};
  let sinaliteProductId = null;
  let totalQuantity = 1;

  console.log('\n📦 Line items found:');
  for (const item of lineItems) {
    console.log(`  - "${item.title}" | SKU: "${item.sku}" | Qty: ${item.quantity}`);
    console.log(`    Properties: ${JSON.stringify(item.properties)}`);
    if (item.sku && !sinaliteProductId) {
      sinaliteProductId = item.sku;
      totalQuantity = item.quantity;
    }
    if (Array.isArray(item.properties)) {
      for (const prop of item.properties) propertiesMap[prop.name] = prop.value;
    }
  }

  console.log('\n🗂️  Merged properties map:');
  console.log(JSON.stringify(propertiesMap, null, 2));

  if (!sinaliteProductId) throw new Error('❌ No SKU found on any line item! Set SKU on the Shopify product variant.');

  const fileUrl = propertiesMap['File']
               || propertiesMap['file upload 1']
               || propertiesMap['file_upload'];

  if (!fileUrl) {
    console.error('\n❌ No file URL found in properties!');
    console.log('Available property keys:', Object.keys(propertiesMap));
    throw new Error('No file URL in any property');
  }

  console.log(`\n✅ File URL found: ${fileUrl}`);
  console.log(`✅ Sinalite Product ID: ${sinaliteProductId}`);

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
  delete options['file upload 1'];
  delete options['file_upload'];
  delete options['Get email proof(+$5)'];
  delete options['Need Design Services (+$59.99)'];

  const payload = {
    referenceId: String(orderData.id),
    shippingInfo,
    items: [{
      productId: sinaliteProductId,
      quantity: totalQuantity,
      options,
      files: [{ type: 'front', url: fileUrl }],
    }],
  };

  console.log('\n📤 Sending to Sinalite...');
  console.log('Payload:', JSON.stringify(payload, null, 2));

  const response = await fetch('https://api.sinaliteuppy.com/order/new', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${accessToken}`,
    },
    body: JSON.stringify(payload),
  });

  const responseData = await response.json();
  
  if (!response.ok) {
    console.error('\n❌ Sinalite rejected the order:');
    console.error(JSON.stringify(responseData, null, 2));
    return;
  }

  console.log(`\n🎉 SUCCESS! Order #${orderData.order_number} submitted to Sinalite!`);
  console.log(`   Sinalite Order ID: ${responseData.orderId ?? 'N/A'}`);
  console.log(`   Full response:`, JSON.stringify(responseData, null, 2));
}

// ── Run ───────────────────────────────────────────────────────────
(async () => {
  try {
    console.log(`\n🚀 Manual Sinalite Submit — Order ID: ${SHOPIFY_ORDER_ID}\n`);
    const [sinaliteToken, orderData] = await Promise.all([
      getSinaliteToken(),
      fetchShopifyOrder(SHOPIFY_ORDER_ID),
    ]);
    await sendOrderToSinalite(orderData, sinaliteToken);
  } catch (err) {
    console.error('\n💥 Fatal error:', err.message);
  }
})();
