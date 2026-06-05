const { WebClient } = require('@slack/web-api');
require('dotenv').config();

const slack = new WebClient(process.env.SLACK_BOT_TOKEN);

async function testCanvas() {
  console.log('🧪 [Slack Canvas API 테스트] 캔버스 생성 API 동작 여부 확인 중...');
  try {
    const response = await slack.canvases.create({
      title: '🧪 HANSL 봇 캔버스 권한 테스트 리포트',
      content: {
        type: 'markdown',
        markdown: `# 📅 테스트 주간 업무 보고\n\n이 문서는 HANSL 봇의 슬랙 캔버스(Slack Canvas) 권한이 정상 작동함을 테스트하기 위해 생성되었습니다.\n\n### 📝 계획 대비 완료/미완료 대조 (예시 표)\n\n| 5월 4주차 계획 | 완료여부 | 5월 4주차 Daily Work Log |\n| :--- | :---: | :--- |\n| 📄 **웹 페이지 API 연동** | **-** | 📄 **웹 페이지 API 연동** |\n| └ • 센서별 변화 추이 조회 | **✅** | └ • (5/28) 디바이스/센서 상세 정보 모달 실시간 차트 연동 완료 |\n| └ • 기기별 카테고리 적용 | **✅** | └ • (5/29) 디바이스 상세 조회 API 불필요 필드 제거 |\n| └ • 자동화 카테고리 적용 | | └ • (매칭 일지 없음 ➔ 6월 1주차 이관 대상) |\n`
      }
    });

    if (response.ok) {
      console.log('\n🎉 [성공] 슬랙 캔버스 생성에 성공하였습니다!');
      console.log(`- 캔버스 ID: ${response.canvas_id}`);
      console.log(`- 캔버스 URL: ${response.url}`);
    } else {
      console.error('\n❌ [실패] 캔버스 생성 실패:', response);
    }
  } catch (error) {
    console.error('\n❌ [에러] 캔버스 API 호출 중 예외 발생:', error.message);
    if (error.message.includes('missing_scope')) {
      console.error('  -> 원인: 토큰에 canvases:write 권한이 누락되었습니다.');
    }
  }
}

testCanvas();
