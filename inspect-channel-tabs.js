const { WebClient } = require('@slack/web-api');
require('dotenv').config();

const slack = new WebClient(process.env.SLACK_BOT_TOKEN);

async function inspect() {
  const channelName = '스마트팜-workplan';
  console.log(`🔍 [슬랙 채널 인스펙션] '#${channelName}' 내의 캔버스 탭 현황 조회 중...`);
  try {
    // 1. 채널 리스트를 돌며 스마트팜-workplan 채널 정보 획득
    let cursor;
    let targetChannel = null;
    
    while (true) {
      const response = await slack.conversations.list({
        types: 'public_channel,private_channel',
        cursor: cursor
      });

      const channel = response.channels.find(c => c.name === channelName);
      if (channel) {
        targetChannel = channel;
        break;
      }

      cursor = response.response_metadata?.next_cursor;
      if (!cursor) break;
    }

    if (!targetChannel) {
      console.error(`❌ '#${channelName}' 채널을 찾을 수 없습니다.`);
      return;
    }

    console.log(`  -> 채널 발견! ID: ${targetChannel.id}`);

    // properties.tabs 또는 tabz 에 캔버스 정보가 존재하는지 상세 조회
    // conversations.info API를 호출하여 최신 properties 획득
    const infoResponse = await slack.conversations.info({
      channel: targetChannel.id
    });

    const channelInfo = infoResponse.channel;
    const tabs = channelInfo.properties?.tabs || channelInfo.properties?.tabz || [];
    
    const canvasTabs = tabs.filter(t => t.type === 'canvas');

    console.log(`\n==================================================`);
    console.log(`📊 '#${channelName}' 채널의 상단 탭 현황`);
    console.log(`==================================================`);
    console.log(`- 전체 등록된 탭 개수: ${tabs.length}개`);
    console.log(`- 그 중 캔버스(canvas) 타입 탭 개수: ${canvasTabs.length}개`);

    if (canvasTabs.length === 0) {
      console.log(`  -> 현재 채널 상단에 등록/고정된 캔버스 탭이 존재하지 않습니다.`);
    } else {
      canvasTabs.forEach((tab, index) => {
        console.log(`[${index + 1}] 탭 ID: ${tab.id}`);
        console.log(`    - 캔버스 문서 ID (file_id): ${tab.data?.file_id || '없음'}`);
        console.log(`    - 탭 라벨(이름): ${tab.label || '이름 없음'}`);
      });
    }

  } catch (error) {
    console.error('채널 탭 조회 실패:', error.message);
  }
}

inspect();
