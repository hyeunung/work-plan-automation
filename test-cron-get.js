const dotenv = require('dotenv');
dotenv.config();

const apiKey = process.env.CRONJOB_API_KEY;

async function run() {
  console.log('🔄 cron-job.org API 호출 중 (기존 크론 목록 조회)...');
  try {
    const response = await fetch('https://api.cron-job.org/jobs', {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`
      }
    });

    if (!response.ok) {
      throw new Error(`API error: ${response.status} ${await response.text()}`);
    }

    const data = await response.json();
    console.log('==================================================');
    console.log(JSON.stringify(data, null, 2));
    console.log('==================================================');
  } catch (error) {
    console.error('에러 발생:', error.message);
  }
}

run();
