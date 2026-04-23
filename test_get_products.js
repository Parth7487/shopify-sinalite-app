require('dotenv').config();

async function listProducts() {
  try {
    const clientId = process.env.SINALITE_CLIENT_ID;
    const clientSecret = process.env.SINALITE_CLIENT_SECRET;

    console.log('Fetching Token...');
    const authRes = await fetch('https://liveapi.sinalite.com/auth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        audience: 'https://apiconnect.sinalite.com',
        grant_type: 'client_credentials',
      }),
    });
    const authData = await authRes.json();
    const token = authData.access_token;

    console.log('Fetching Product List...');
    const prodRes = await fetch('https://liveapi.sinalite.com/product', {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    
    // Some APIs return huge lists, let's just log the first 20 products
    const products = await prodRes.json();
    console.log('\n--- SINALITE PRODUCT LIST ---');
    products.slice(0, 20).forEach(p => {
       console.log(`ID: ${p.id}  -  Name: ${p.name}`);
    });
    console.log('-----------------------------\n');

  } catch (err) {
    console.error(err);
  }
}

listProducts();
