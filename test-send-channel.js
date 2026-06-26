const dotenv = require('dotenv');
dotenv.config();

const slackService = require('./src/services/slackService');

async function testChannel(channelName) {
  console.log(`\n==================================================`);
  console.log(`📢 채널 '${channelName}' 테스트 진행 중...`);
  console.log(`==================================================`);
  try {
    const channelId = await slackService.findChannelIdByName(channelName);
    console.log(`  -> 채널 ID 감지 결과: ${channelId}`);
    
    // slack API 직접 인스턴스 획득 (slackService.js 내부 인스턴스 위임 호출)
    const { WebClient } = require('@slack/web-api');
    const config = require('./src/config');
    const slack = new WebClient(config.slack.token);
    
    const response = await slack.chat.postMessage({
      channel: channelId,
      text: `🤖 *[HANSL 봇 연동 테스트]* 비공개 채널 \`${channelName}\` 에 테스트 메시지 발송에 성공했습니다! 🎉`,
      mrkdwn: true
    });
    
    if (response.ok) {
      console.log(`  -> 🎉 '${channelName}' 채널에 메시지 전송 성공! (TS: ${response.ts})`);
    } else {
      console.error(`  -> ❌ 메시지 전송 실패: ok가 아님`);
    }
  } catch (error) {
    console.error(`  -> ❌ '${channelName}' 채널 테스트 실패:`, error.message);
  }
}

async function run() {
  await testChannel('일일업무보고');
  await testChannel('주간업무보고');
}

run();
