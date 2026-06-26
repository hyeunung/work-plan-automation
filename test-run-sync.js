const app = require('./src/app');

async function run() {
  console.log('🔄 프로젝트 상태 싱크 수동 테스트 가동...');
  await app.executeProjectStatusSyncPipeline();
  console.log('🏁 테스트 완료!');
}

run();
