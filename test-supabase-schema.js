const dotenv = require('dotenv');
dotenv.config();

const config = require('./src/config');

async function run() {
  const url = `${config.supabase.url}/rest/v1/business_trips?limit=1`;
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'apikey': config.supabase.key,
        'Authorization': `Bearer ${config.supabase.key}`,
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      throw new Error(`API status error: ${response.status}`);
    }

    const data = await response.json();
    console.log('==================================================');
    console.log('business_trips 한 건 데이터:');
    console.log(JSON.stringify(data[0], null, 2));
    console.log('==================================================');
  } catch (error) {
    console.error('에러 발생:', error.message);
  }
}

run();
