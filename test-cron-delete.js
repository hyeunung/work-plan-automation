const dotenv = require('dotenv');
dotenv.config();

const apiKey = process.env.CRONJOB_API_KEY;
const jobId = 7918629; // 지우고자 하는 Project Status Sync 기존 Job ID

async function run() {
  console.log(`🔄 cron-job.org API 호출 중 (크론잡 ID ${jobId} 삭제)...`);
  try {
    const response = await fetch(`https://api.cron-job.org/jobs/${jobId}`, {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${apiKey}`
      }
    });

    if (!response.ok) {
      throw new Error(`API error: ${response.status} ${await response.text()}`);
    }

    console.log('🎉 크론잡 삭제 성공!');
  } catch (error) {
    console.error('에러 발생:', error.message);
  }
}

run();
