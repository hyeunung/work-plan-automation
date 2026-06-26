const { WebClient } = require('@slack/web-api');
const config = require('./src/config');
const slackService = require('./src/services/slackService');

async function test() {
  console.log('🔄 정현웅 님에게 지연 태스크 테스트 메시지 발송 중...');
  
  // 정현웅 님 ID 조회
  let targetUserId = config.slack.adminUserId || 'U0B1U11SBE2';
  try {
    const userClient = new WebClient(config.slack.userToken);
    const authRes = await userClient.auth.test();
    if (authRes && authRes.user_id) {
      targetUserId = authRes.user_id;
    }
  } catch (err) {
    console.warn('ID 동적 조회 실패, 기본 ID 사용:', err.message);
  }

  // 예시 데이터 작성
  const mockTasks = [
    { title: '[센서노드] F767 펌웨어 리팩토링 및 기능 개선', dueDate: '2026-06-19', delayDays: 7, projectName: '아키텍쳐 설계' },
    { title: '[센서노드] 펌프 유량계 설치, 측정', dueDate: '2026-06-19', delayDays: 7, projectName: '솔루션 1차 프로토타입' },
    { title: '[드레인] 잔류량·희석효과·컴프레셔효과 확인', dueDate: '2026-06-19', delayDays: 7, projectName: '무인방제-연질관노즐식' }
  ];

  let text = `안녕하세요 정현웅 님 🙂 (자동화 테스트 메시지)\n`;
  text += `담당하신 태스크 중 종료일(6/19)이 지났는데 아직 "🚀 진행 중"으로 남아 있는 항목이 ${mockTasks.length}건 있어 확인 부탁드립니다.\n`;
  text += `각 항목별로, 완료된 건은 "✅ 완료"로 변경해주시고 / 아직 진행 중이면 종료일자를 연장해주세요.\n\n`;

  mockTasks.forEach(task => {
    text += `D+${task.delayDays} ${task.title} — ${task.projectName}\n`;
  });

  text += `\n확인 후 업데이트 부탁드립니다. 감사합니다!`;

  await slackService.sendDirectMessage(targetUserId, text);
  console.log(`🏁 발송 완료! (대상 ID: ${targetUserId})`);
}

test();
