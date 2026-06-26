const dotenv = require('dotenv');
dotenv.config();

const apiKey = process.env.CRONJOB_API_KEY;

// 기존 jobDetails에서 복제하여 생성할 Payload 정의
const newJobPayload = {
  job: {
    title: "HANSL Project Status Sync",
    url: "https://api.github.com/repos/hyeunung/work-plan-automation/actions/workflows/daily-scheduler.yml/dispatches",
    enabled: true,
    saveResponses: true,
    schedule: {
      timezone: "Asia/Seoul",
      hours: [8], // 오전 8시
      mdays: [-1],
      minutes: [30], // 30분
      months: [-1],
      wdays: [1, 2, 3, 4, 5], // 평일 (월~금)
      expiresAt: 0
    },
    requestMethod: 1, // POST
    extendedData: {
      headers: {
        "Accept": "application/vnd.github+json",
        "Authorization": `Bearer ${process.env.GITHUB_PAT}`,
        "Content-Type": "application/json",
        "User-Agent": "cron-job-org",
        "X-GitHub-Api-Version": "2022-11-28"
      },
      body: JSON.stringify({
        ref: "main",
        inputs: {
          pipeline_type: "project-sync"
        }
      }, null, 2) + "\n"
    }
  }
};

async function run() {
  console.log('🔄 cron-job.org API 호출 중 (지연 태스크 크론잡 신규 등록)...');
  try {
    const response = await fetch('https://api.cron-job.org/jobs', {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(newJobPayload)
    });

    if (!response.ok) {
      throw new Error(`API error: ${response.status} ${await response.text()}`);
    }

    const data = await response.json();
    console.log('🎉 크론잡 생성 성공!');
    console.log('==================================================');
    console.log(JSON.stringify(data, null, 2));
    console.log('==================================================');
  } catch (error) {
    console.error('에러 발생:', error.message);
  }
}

run();
