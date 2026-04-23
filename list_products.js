const fs = require('fs');

async function run() {
    try {
        const auth = await fetch("https://api.sinaliteuppy.com/auth/token", {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
                client_id: "nRlq7QdyxprU8sjMqUZSu0DY0DJQvC9h",
                client_secret: "gDSgKnwttdmWusppyPH39Cf0HJ5f-ewpe2APml6X6azDruiM9Gm2pPbS-NkW7nyL",
                audience: "https://apiconnect.sinalite.com",
                grant_type: "client_credentials"
            })
        });
        const authData = await auth.json();
        const token = authData.access_token;

        const productsResp = await fetch("https://api.sinaliteuppy.com/product", {
            headers: { "Authorization": `Bearer ${token}` }
        });
        const products = await productsResp.json();
        
        let out = '';
        products.forEach(p => {
           out += `${p.id} | ${p.sku} | ${p.name}\n`;
        });
        fs.writeFileSync('/tmp/sinalite_list.txt', out);
        console.log("Wrote list");
    } catch(e) { console.error(e); }
}
run();
