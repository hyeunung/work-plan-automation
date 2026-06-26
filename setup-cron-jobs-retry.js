const dotenv = require('dotenv');
dotenv.config();

const apiKey = process.env.CRONJOB_API_KEY;
const githubPat = process.env.GITHUB_PAT;

if (!apiKey || !githubPat) {
  console.error('❌ CRONJOB_API_KEY 또는 GITHUB_PAT 환경변수가 존재하지 않습니다.');
  process.exit(1);
}

const jobsToCreate = [
  // 6. 주간 계획 작성 독려 개인 DM (금요일 17:30)
  {
    title: "HANSL Weekly Reminder (New)",
    pipelineType: "weekly-reminder",
    schedule: {
      hours: [17],
      minutes: [30],
      wdays: [5]
    }
  },
  // 7. 주간 업무보고 1차 (금요일 18:10)
  {
    title: "HANSL Weekly Report - 1st (New)",
    pipelineType: "weekly",
    schedule: {
      hours: [18],
      minutes: [10],
      wdays: [5]
    }
  },
  // 8. 주간 업무보고 2차 (금요일 21:00)
  {
    title: "HANSL Weekly Report - 2nd Audit (New)",
    pipelineType: "weekly",
    schedule: {
      hours: [21],
      minutes: [0],
      wdays: [5]
    }
  },
  // 9. 주간 업무보고 3차 (금요일 23:00)
  {
    title: "HANSL Weekly Report - 3rd Audit (New)",
    pipelineType: "weekly",
    schedule: {
      hours: [23],
      minutes: [0],
      wdays: [5]
    }
  },
  // 10. 주간 업무보고 최종 확정 (월요일 08:30)
  {
    title: "HANSL Weekly Report - Final Audit (New)",
    pipelineType: "weekly",
    schedule: {
      hours: [8],
      minutes: [30],
      wdays: [1]
    }
  }
];

async function createJob(jobSpec) {
  console.log(`➕ 크론잡 생성 요청 중: "${jobSpec.title}"...`);
  const payload = {
    job: {
      title: jobSpec.title,
      url: "https://api.github.com/repos/hyeunung/work-plan-automation/actions/workflows/daily-scheduler.yml/dispatches",
      enabled: true,
      saveResponses: true,
      schedule: {
        timezone: "Asia/Seoul",
        hours: jobSpec.schedule.hours,
        mdays: [-1],
        minutes: jobSpec.schedule.minutes,
        months: [-1],
        wdays: jobSpec.schedule.wdays,
        expiresAt: 0
      },
      requestMethod: 1, // POST
      extendedData: {
        headers: {
          "Accept": "application/vnd.github+json",
          "Authorization": `Bearer ${githubPat}`,
          "Content-Type": "application/json",
          "User-Agent": "cron-job-org",
          "X-GitHub-Api-Version": "2022-11-28"
        },
        body: JSON.stringify({
          ref: "main",
          inputs: {
            pipeline_type: jobSpec.pipelineType
          }
        }, null, 2) + "\n"
      }
    }
  };

  const response = await fetch('https://api.cron-job.org/jobs', {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`생성 실패 (status: ${response.status}): ${errText}`);
  }
  const data = await response.json();
  console.log(`✅ 크론잡 생성 성공: "${jobSpec.title}" (New ID: ${data.jobId})`);
}

async function run() {
  console.log('🔄 === 크론 스케줄 재시도 생성 작업 시작 ===');
  
  for (const jobSpec of jobsToCreate) {
    try {
      await createJob(jobSpec);
      // 레이트 리밋 우회를 위해 15초 대기
      console.log('API Rate Limit 방지를 위해 15초 대기합니다...');
      await new Promise(resolve => setTimeout(resolve, 15000));
    } catch (err) {
      console.error(`❌ "${jobSpec.title}" 생성 중 에러:`, err.message);
    }
  }

  console.log('\n🎉 === 모든 크론 스케줄 재시도 마이그레이션 작업 완료 ===');
}

run();
