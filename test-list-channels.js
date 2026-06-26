const dotenv = require('dotenv');
dotenv.config();

const { WebClient } = require('@slack/web-api');
const config = require('./src/config');
const slack = new WebClient(config.slack.token);

async function run() {
  console.log('🔄 봇이 접근 가능한 모든 슬랙 채널 목록 조회 중...');
  try {
    let cursor;
    let allChannels = [];
    
    while (true) {
      const response = await slack.users.conversations({
        types: 'public_channel,private_channel',
        cursor: cursor
      });

      if (response.ok && response.channels) {
        allChannels = allChannels.concat(response.channels);
      }

      cursor = response.response_metadata?.next_cursor;
      if (!cursor) break;
    }

    console.log('==================================================');
    console.log(`총 ${allChannels.length}개의 채널을 발견했습니다.`);
    allChannels.forEach(c => {
      console.log(`- [#${c.name}] ID: ${c.id} (비공개여부: ${c.is_private}, 참여여부: ${c.is_member})`);
    });
    console.log('==================================================');
  } catch (error) {
    console.error('에러 발생:', error.message);
  }
}

run();
