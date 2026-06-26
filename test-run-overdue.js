const app = require('./src/app');

async function run() {
  console.log('🔄 지연 태스크 독려 DM 발송 수동 테스트 가동...');
  // 공휴일/주말 검사를 우회하기 위해 로직을 직접 실행할 수도 있으나,
  // 오늘은 평일(금요일, 2026-06-26)이므로 executeOverdueTasksReminderPipeline()을 바로 호출하면 동작할 것입니다.
  // 혹시 주말에 수동 테스트할 때를 대비하여 pipeline 내의 holiday check는 통과하도록 호출합니다.
  await app.executeOverdueTasksReminderPipeline();
  console.log('🏁 테스트 완료!');
}

run();
