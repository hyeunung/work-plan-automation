const { WebClient } = require('@slack/web-api');
const config = require('../config');
const fs = require('fs');
const path = require('path');
const supabaseService = require('./supabaseService');

const slack = new WebClient(config.slack.token);

const MEMBER_EMAILS = {
  '김윤회': 'yoon-whoi.kim@hansl.com',
  '김희승': 'hee-seung.kim@hansl.com',
  '최현빈': 'hyun-bin.choi@hansl.com'
};

const userIdCache = {};

/**
 * 채널명(예: '스마트팜-workplan')을 받아 해당하는 실시간 슬랙 채널 ID를 조회합니다.
 */
async function findChannelIdByName(channelName) {
  try {
    const cleanName = channelName.replace('#', '').trim();
    let cursor;
    
    while (true) {
      const response = await slack.conversations.list({
        types: 'public_channel,private_channel',
        cursor: cursor
      });

      const channel = response.channels.find(c => c.name === cleanName);
      if (channel) {
        console.log(`  -> 실시간 채널 감지 성공: #${cleanName} (ID: ${channel.id})`);
        return channel.id;
      }

      cursor = response.response_metadata?.next_cursor;
      if (!cursor) break;
    }
    
    return config.slack.channelId;
  } catch (error) {
    console.error(`채널명 '${channelName}' 조회 실패:`, error.message);
    return config.slack.channelId;
  }
}

/**
 * AWS S3 Presigned URL의 ImgProxy 차단 우회를 위해 TinyURL로 단축합니다.
 */
async function getShortUrl(longUrl) {
  try {
    const encodedUrl = encodeURIComponent(longUrl);
    const apiUrl = `https://tinyurl.com/api-create.php?url=${encodedUrl}`;
    const response = await fetch(apiUrl);
    if (!response.ok) {
      throw new Error(`TinyURL API status error: ${response.status}`);
    }
    const shortUrl = await response.text();
    return shortUrl.trim() || longUrl;
  } catch (error) {
    console.error('TinyURL 단축 실패:', error.message);
    return longUrl;
  }
}

/**
 * 이미지 URL을 Supabase Storage에 백업 업로드하여 영구적인 Public URL을 반환합니다.
 * 업로드 실패 시 TinyURL 단축 주소로 fallback 합니다.
 */
async function getPermanentImageUrl(longUrl) {
  if (!longUrl) return '';
  
  // 이미 Supabase Storage workplan 버킷 경로라면 그대로 반환
  if (longUrl.includes('supabase.co/storage/v1/object/public/workplan')) {
    return longUrl;
  }
  
  try {
    const permanentUrl = await supabaseService.uploadImageToStorage(longUrl);
    // 업로드 실패 시 원본 URL이 반환되므로, 이 경우 TinyURL 단축 적용
    if (permanentUrl === longUrl) {
      console.warn('[Slack Service] Supabase 이미지 업로드 실패, TinyURL 단축을 적용합니다.');
      return await getShortUrl(longUrl);
    }
    return permanentUrl;
  } catch (error) {
    console.error('[Slack Service] 영구 이미지 URL 변환 중 예외 발생:', error.message);
    return await getShortUrl(longUrl);
  }
}


/**
 * 날짜 문자열을 받아 요일을 포함한 형식으로 변환합니다.
 */
function formatDayLabel(dateStr) {
  const dateObj = new Date(dateStr);
  const month = String(dateObj.getUTCMonth() + 1).padStart(2, '0');
  const day = String(dateObj.getUTCDate()).padStart(2, '0');
  
  const weekdays = ['일요일', '월요일', '화요일', '수요일', '목요일', '금요일', '토요일'];
  const dayOfWeek = weekdays[dateObj.getUTCDay()];

  return `${month}월 ${day}일 (${dayOfWeek})`;
}

/**
 * 텍스트 패딩 계산 함수 (한글 문자 너비 보정 포함)
 */
function getVisualWidth(str) {
  let width = 0;
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code >= 0xac00 && code <= 0xd7a3 || code >= 0x3000 && code <= 0x303f || code >= 0xff00 && code <= 0xffef) {
      width += 2;
    } else {
      width += 1;
    }
  }
  return width;
}

function padRight(str, targetWidth) {
  const currentWidth = getVisualWidth(str);
  if (currentWidth >= targetWidth) return str;
  return str + ' '.repeat(targetWidth - currentWidth);
}

/**
 * 100% 안전한 슬랙 캔버스용 마크다운 리포트 텍스트를 빌드합니다.
 */
function buildCanvasMarkdownContent({ weekTitle, nextWeekTitle, memberName, analysisResults, dailyLogs, nextWeekPlan, tasksMap, startDate, endDate }) {
  const cleanMemberName = memberName.replace(' 님', '');
  
  let markdownContent = `# 📅 [${weekTitle}] 주간 업무 브리핑 - ${cleanMemberName} 님\n`;
  markdownContent += `> 월요일 출근 시간 전, 지난주 업무 분석 및 금주 계획 종합 브리핑입니다.\n\n`;
  markdownContent += `---\n\n`;

  // 날짜 범위 포맷팅 (YYYY-MM-DD -> M/D~M/D)
  let periodLabel = '';
  if (startDate && endDate) {
    const startObj = new Date(startDate);
    const endObj = new Date(endDate);
    const startM = startObj.getUTCMonth() + 1;
    const startD = startObj.getUTCDate();
    const endM = endObj.getUTCMonth() + 1;
    const endD = endObj.getUTCDate();
    periodLabel = ` (${startM}/${startD}~${endM}/${endD})`;
  }

  // Part 1. 지난주 실제 업무 보고
  markdownContent += `## 📂 1. 지난주 실제 업무 보고 (Daily Work Log)${periodLabel}\n\n`;

  const logsByDate = {};
  dailyLogs.forEach(log => {
    if (!logsByDate[log.date]) logsByDate[log.date] = [];
    logsByDate[log.date].push(log);
  });

  const sortedDates = Object.keys(logsByDate).sort();

  if (sortedDates.length === 0) {
    markdownContent += `*지난주 기록된 Daily Work Log가 없습니다.*\n\n`;
  } else {
    sortedDates.forEach(date => {
      const formattedDate = formatDayLabel(date);
      markdownContent += `### ■ ${formattedDate}\n`;

      logsByDate[date].forEach(log => {
        // 일지와 연결된 Task 중 하나라도 "스마트팜 외 업무" 에 속하는지 실시간 판별
        const isOutsideWork = log.taskRelations.some(rel => {
          const taskInfo = tasksMap && tasksMap[rel.id];
          return taskInfo && taskInfo.projectName === '스마트팜 외 업무';
        });

        if (isOutsideWork) {
          // 스마트팜 외 업무는 구체적 기술 없이 축약 출력 (연동된 실제 태스크명 기재) 및 상세 생략
          const taskNames = log.taskRelations
            .map(rel => tasksMap[rel.id]?.name)
            .filter(Boolean);
          const taskNameStr = taskNames.length > 0 ? taskNames.join(', ') : '스마트팜 외 업무';
          markdownContent += `* **[${taskNameStr} (스마트팜 외 업무)](${log.url})**\n`;
        } else {
          // 일반 스마트팜 업무는 기존처럼 아주 상세하게 출력
          const cleanTitle = log.title.replace(/[📄@]/g, '').trim();
          markdownContent += `* **[${cleanTitle}](${log.url})**\n`;
          
          if (log.details && log.details.trim()) {
            const detailLines = log.details.trim().split('\n');
            detailLines.forEach(line => {
              if (line.trim()) {
                markdownContent += `  * (상세: ${line.trim()})\n`;
              }
            });
          }
        }
      });
      markdownContent += `\n`;
    });
  }

  markdownContent += `---\n\n`;

  // Part 2. 계획 대비 완료/미완료 대조 (슬랙 캔버스 전용 리치 마크다운 표)
  markdownContent += `## 📝 2. 계획 대비 완료/미완료 대조 (${weekTitle} 대조 표)\n\n`;
  markdownContent += `| ${weekTitle} 계획 | 완료여부 | ${weekTitle} Daily Work Log |\n`;
  markdownContent += `| :--- | :---: | :--- |\n`;

  analysisResults.forEach(task => {
    const cleanTaskName = task.taskName.replace(/[📄@]/g, '').trim();
    
    // 마감일자 정보가 존재할 경우 (~M/D) 라벨 생성
    let dateLabel = '';
    if (task.dueDate) {
      const dateObj = new Date(task.dueDate);
      const m = dateObj.getUTCMonth() + 1;
      const d = dateObj.getUTCDate();
      dateLabel = ` (~${m}/${d})`;
    }

    // 대분류 행: 대칭 구조 및 '-' 대조 (마감일자 포함) - 태스크 제목에 Notion Task 페이지 하이퍼링크 직접 탑재!
    const taskLink = task.taskUrl ? `[${cleanTaskName}](${task.taskUrl})` : cleanTaskName;
    markdownContent += `| 📄 **${taskLink}${dateLabel}** | **-** | 📄 **${taskLink}${dateLabel}** |\n`;

    task.subItems.forEach(sub => {
      const cleanItemName = sub.itemName.replace(/[📄@]/g, '').trim();
      const col1Val = `└ • ${cleanItemName}`;
      
      // 완료 시 ✅, 미완료 시 ❌ (x 이모티콘 배치)
      const col2Val = sub.isCompleted ? '✅' : '❌';

      let col3Val = '';
      if (sub.isCompleted && sub.matchingLog) {
        const logDate = sub.matchingLog.date;
        const dateObj = new Date(logDate);
        const formattedDate = `${dateObj.getUTCMonth() + 1}/${dateObj.getUTCDate()}`;
        const cleanLogTitle = sub.matchingLog.title.replace(/[📄@]/g, '').trim();
        // 캔버스 마크다운 링크 카드 연동
        col3Val = `└ • (${formattedDate}) [${cleanLogTitle}](${sub.matchingLog.url})`;
      } else if (sub.isCompleted && sub.isAlreadyChecked) {
        col3Val = `└ • (완료됨) ${cleanItemName}`;
      } else {
        // 미완료된 경우 3열은 완전히 비워둠 (공백 한 칸)
        col3Val = ' ';
      }

      markdownContent += `| ${col1Val} | ${col2Val} | ${col3Val} |\n`;
    });
  });

  markdownContent += `---\n\n`;

  // Part 3. 이번 주 업무 계획
  markdownContent += `## 🚀 3. 이번 주 업무 계획 (${nextWeekTitle})\n\n`;
  
  if (!nextWeekPlan || nextWeekPlan.length === 0) {
    markdownContent += `*이번 주 등록된 계획이 없습니다.*\n`;
  } else {
    let activeProjectName = '';

    nextWeekPlan.forEach(task => {
      const cleanTaskName = task.taskName.replace(/[📄@]/g, '').trim();
      
      // 마감일자 정보가 존재할 경우 (~M/D) 라벨 생성
      let dateLabel = '';
      if (task.dueDate) {
        const dateObj = new Date(task.dueDate);
        const m = dateObj.getUTCMonth() + 1;
        const d = dateObj.getUTCDate();
        dateLabel = ` (~${m}/${d})`;
      }

      const taskLink = task.taskUrl ? `[${cleanTaskName}](${task.taskUrl})` : cleanTaskName;

      if (task.isProjectGroup) {
        // 상위 프로젝트/그룹을 만난 경우
        activeProjectName = cleanTaskName;
        markdownContent += `### 📁 Project: ${taskLink}\n`;
        
        // 만약 상위 프로젝트 본문 자체에 하위 불릿(예: 스마트팜 외 업무 아래의 텍스트들)이 달려있다면 렌더링
        if (task.subItems && task.subItems.length > 0) {
          task.subItems.forEach(sub => {
            const cleanSubName = sub.itemName.replace(/[📄@]/g, '').trim();
            markdownContent += `* ${cleanSubName}\n`;
          });
          markdownContent += `\n`;
        }
      } else {
        // 일반 태스크를 만난 경우
        // 만약 이 태스크가 현재 활성화된 상위 프로젝트 소속이라면 계층 구조로 안착시킴!
        if (task.projectName && (task.projectName === activeProjectName || activeProjectName !== '')) {
          markdownContent += `* **Task: ${taskLink}${dateLabel}**\n`;
          
          task.subItems.forEach(sub => {
            const cleanSubName = sub.itemName.replace(/[📄@]/g, '').trim();
            const wasIncompleteLastWeek = analysisResults.some(lastTask => 
              lastTask.subItems.some(lastSub => !lastSub.isCompleted && lastSub.itemName === sub.itemName)
            );

            if (wasIncompleteLastWeek) {
              markdownContent += `  * ${cleanSubName} *(★ 지난주 미완료 이관 보완)*\n`;
            } else {
              markdownContent += `  * ${cleanSubName}\n`;
            }
          });
        } else {
          // 상위 프로젝트가 아예 없는 독립 태스크인 경우
          markdownContent += `### 🔗 Task: ${taskLink}${dateLabel}\n`;
          
          task.subItems.forEach(sub => {
            const cleanSubName = sub.itemName.replace(/[📄@]/g, '').trim();
            const wasIncompleteLastWeek = analysisResults.some(lastTask => 
              lastTask.subItems.some(lastSub => !lastSub.isCompleted && lastSub.itemName === sub.itemName)
            );

            if (wasIncompleteLastWeek) {
              markdownContent += `* ${cleanSubName} *(★ 지난주 미완료 이관 보완)*\n`;
            } else {
              markdownContent += `* ${cleanSubName}\n`;
            }
          });
          markdownContent += `\n`;
        }
      }
    });
  }

  return markdownContent;
}

/**
 * [초중요 기능] 사용자가 수동 개설한 캔버스 ID에 대해 본문 마크다운을 실시간 전체 덮어쓰기(수정)하여 갱신합니다.
 */
async function updateWeeklyReportCanvas({ canvasId, weekTitle, nextWeekTitle, memberName, analysisResults, dailyLogs, nextWeekPlan, tasksMap, startDate, endDate }) {
  try {
    const cleanMemberName = memberName.replace(' 님', '');
    const markdownContent = buildCanvasMarkdownContent({
      weekTitle,
      nextWeekTitle,
      memberName,
      analysisResults,
      dailyLogs,
      nextWeekPlan,
      tasksMap,
      startDate,
      endDate
    });

    // canvases.edit API는 권한 제약이 심하므로, 설정된 정현웅 님의 유저 토큰이 존재할 경우 유저 권한으로 실행합니다.
    const slackClient = config.slack.userToken 
      ? new WebClient(config.slack.userToken) 
      : slack;

    console.log(`  -> 수동 개설된 캔버스(${canvasId})에 '${cleanMemberName} 님'의 기존 내용 삭제(비우기) 중...`);
    
    // 캔버스 비우기
    try {
      await slackClient.apiCall('canvases.edit', {
        canvas_id: canvasId,
        changes: [
          {
            operation: 'replace',
            document_content: {
              type: 'markdown',
              markdown: ' '
            }
          }
        ]
      });
      console.log(`  -> 🎉 '${cleanMemberName} 님'의 캔버스 내용 삭제 완료!`);
    } catch (clearErr) {
      console.warn(`  -> ⚠️ 캔버스 내용 비우기 실패 (계속 진행):`, clearErr.message);
    }

    // 안전하게 1.5초 대기
    console.log(`  -> 1.5초 대기 중...`);
    await new Promise(resolve => setTimeout(resolve, 1500));

    console.log(`  -> 수동 개설된 캔버스(${canvasId})에 '${cleanMemberName} 님'의 리포트를 실시간 업데이트 중... (사용 권한: ${config.slack.userToken ? '정현웅 님 유저 권한' : 'HANSL 봇 권한'})`);

    // canvases.edit API 호출: range 없이 document_content만 전달하여 전체 영역 덮어쓰기(replace) 실행!
    // 1. 캔버스 제목(Title) 업데이트
    try {
      await slackClient.apiCall('canvases.edit', {
        canvas_id: canvasId,
        changes: [
          {
            operation: 'rename',
            title_content: {
              type: 'markdown',
              markdown: `${cleanMemberName} - ${weekTitle}`
            }
          }
        ]
      });
      console.log(`  -> 🎉 캔버스(${canvasId}) 제목 실시간 수정 완료!`);
    } catch (titleErr) {
      console.warn(`  -> ⚠️ 캔버스 제목 수정 실패 (계속 진행):`, titleErr.message);
    }

    // 2. 캔버스 본문(Content) 업데이트
    const response = await slackClient.apiCall('canvases.edit', {
      canvas_id: canvasId,
      changes: [
        {
          operation: 'replace',
          document_content: {
            type: 'markdown',
            markdown: markdownContent
          }
        }
      ]
    });

    if (response.ok) {
      console.log(`  -> 🎉 캔버스(${canvasId}) 본문 실시간 덮어쓰기(수정) 완료!`);
      
      // [신규] 깃허브 아카이브용 주간 보고서 마크다운 저장
      try {
        const reportDir = path.join(__dirname, '../../docs/weekly-reports');
        if (!fs.existsSync(reportDir)) {
          fs.mkdirSync(reportDir, { recursive: true });
        }
        const cleanMemberName = memberName.replace(' 님', '').trim();
        const safeWeekTitle = weekTitle.replace(/\s+/g, '');
        const filename = `${safeWeekTitle}_${cleanMemberName}.md`;
        const savePath = path.join(reportDir, filename);
        
        fs.writeFileSync(savePath, markdownContent, 'utf8');
        console.log(`  -> 📂 [마크다운 저장] 주간 보고서 파일 기록 성공: docs/weekly-reports/${filename}`);
      } catch (fsErr) {
        console.warn(`  -> ⚠️ 주간 보고서 파일 저장 실패 (계속 진행):`, fsErr.message);
      }

      return {
        canvasId: canvasId,
        canvasUrl: `slack://file?id=${canvasId}&team=${config.slack.teamId || 'T0B2QAU647J'}`
      };
    } else {
      throw new Error(`canvases.edit API 갱신 실패: ${JSON.stringify(response)}`);
    }
  } catch (error) {
    console.error(`캔버스(${canvasId}) 업데이트 실패:`, error.message);
    throw error;
  }
}

/**
 * 개별 직원의 주간업무 리포트 본문을 고가독성 3열 박스 격자 표 텍스트로 가공합니다 (일반 메시지용).
 */
async function buildEmployeeReportText({ weekTitle, nextWeekTitle, memberName, analysisResults, dailyLogs, nextWeekPlan, tasksMap, startDate, endDate }) {
  const cleanMemberName = memberName.replace(' 님', '');
  let text = `*👤 [담당자: ${cleanMemberName} 님 주간 업무 브리핑]*\n`;
  text += `──────────────────────────────────────\n\n`;

  let periodLabel = '';
  if (startDate && endDate) {
    const startObj = new Date(startDate);
    const endObj = new Date(endDate);
    const startM = startObj.getUTCMonth() + 1;
    const startD = startObj.getUTCDate();
    const endM = endObj.getUTCMonth() + 1;
    const endD = endObj.getUTCDate();
    periodLabel = ` (${startM}/${startD}~${endM}/${endD})`;
  }
  text += `*📂 1. 지난주 실제 업무 보고 (Daily Work Log)${periodLabel}*\n`;
  const logsByDate = {};
  dailyLogs.forEach(log => {
    if (!logsByDate[log.date]) logsByDate[log.date] = [];
    logsByDate[log.date].push(log);
  });

  const sortedDates = Object.keys(logsByDate).sort();

  if (sortedDates.length === 0) {
    text += `  _(지난주 기록된 Daily Work Log가 없습니다.)_\n\n`;
  } else {
    for (const date of sortedDates) {
      const formattedDate = formatDayLabel(date);
      text += `  *■ ${formattedDate}*\n`;
      for (const log of logsByDate[date]) {
        // 일지와 연결된 Task 중 하나라도 "스마트팜 외 업무" 에 속하는지 실시간 판별
        const isOutsideWork = log.taskRelations.some(rel => {
          const taskInfo = tasksMap && tasksMap[rel.id];
          return taskInfo && taskInfo.projectName === '스마트팜 외 업무';
        });

        if (isOutsideWork) {
          const taskNames = log.taskRelations
            .map(rel => tasksMap[rel.id]?.name)
            .filter(Boolean);
          const taskNameStr = taskNames.length > 0 ? taskNames.join(', ') : '스마트팜 외 업무';
          text += `    • <${log.url}|${taskNameStr} (스마트팜 외 업무)>\n`;
        } else {
          const cleanTitle = log.title.replace(/[📄@]/g, '').trim();
          text += `    • <${log.url}|${cleanTitle}>\n`;
          
          if (log.details && log.details.trim()) {
            const detailLines = log.details.trim().split('\n');
            for (const line of detailLines) {
              if (line.trim()) {
                const formattedLine = await formatLinksInText(line.trim());
                const cleanLineText = formattedLine.replace(/[•\-\*\s\(\)]/g, '').trim();
                if (cleanLineText.length > 0) {
                  text += `      └ (상세: ${formattedLine.trim()})\n`;
                }
              }
            }
          }
        }
      }
      text += '\n';
    }
  }

  text += `*📝 2. 계획 대비 완료/미완료 대조 (5월 4주차 대조 표)*\n`;
  text += `\`\`\`\n`;

  const col1Width = 34;
  const col2Width = 10;
  const col3Width = 46;

  text += `┌${'─'.repeat(col1Width/2)}┬${'─'.repeat(col2Width/2)}┬${'─'.repeat(col3Width/2)}┐\n`;
  text += `│${padRight(' 지난주 계획', col1Width)}│${padRight(' 완료여부', col2Width)}│${padRight(' 지난주 Daily Work Log', col3Width)}│\n`;
  text += `├${'─'.repeat(col1Width/2)}┼${'─'.repeat(col2Width/2)}┼${'─'.repeat(col3Width/2)}┤\n`;

  analysisResults.forEach(task => {
    const cleanTaskName = task.taskName.replace(/[📄@]/g, '').trim();
    const taskCol1 = cleanTaskName.length > 15 ? cleanTaskName.substring(0, 14) + '...' : cleanTaskName;
    const taskCol2 = '    -     ';
    const taskCol3 = taskCol1;

    text += `│${padRight(taskCol1, col1Width)}│${padRight(taskCol2, col2Width)}│${padRight(taskCol3, col3Width)}│\n`;

    task.subItems.forEach(sub => {
      const cleanItemName = sub.itemName.replace(/[📄@]/g, '').trim();
      const col1Val = `  └ • ${cleanItemName}`;
      const col2Val = sub.isCompleted ? '    ✅    ' : '          ';

      let col3Val = '';
      if (sub.isCompleted && sub.matchingLog) {
        const logDate = sub.matchingLog.date;
        const dateObj = new Date(logDate);
        const formattedDate = `${dateObj.getUTCMonth() + 1}/${dateObj.getUTCDate()}`;
        const cleanLogTitle = sub.matchingLog.title.replace(/[📄@]/g, '').trim();
        col3Val = `  └ • (${formattedDate}) ${cleanLogTitle}`;
      } else if (sub.isCompleted && sub.isAlreadyChecked) {
        col3Val = `  └ • (완료됨) ${cleanItemName}`;
      } else {
        col3Val = `  └ • (매칭 일지 없음 ➔ 이관)`;
      }

      const col1Trimmed = col1Val.length > 20 ? col1Val.substring(0, 19) + '...' : col1Val;
      const col3Trimmed = col3Val.length > 30 ? col3Val.substring(0, 29) + '...' : col3Val;

      text += `│${padRight(col1Trimmed, col1Width)}│${padRight(col2Val, col2Width)}│${padRight(col3Trimmed, col3Width)}│\n`;
    });

    text += `├${'─'.repeat(col1Width/2)}┼${'─'.repeat(col2Width/2)}┼${'─'.repeat(col3Width/2)}┤\n`;
  });

  text = text.trim().replace(/├───────.+┤$/, `└${'─'.repeat(col1Width/2)}┴${'─'.repeat(col2Width/2)}┴${'─'.repeat(col3Width/2)}┘`) + '\n';
  text += `\`\`\`\n\n`;

  text += `*🚀 3. 이번 주 업무 계획 (${nextWeekTitle} 계획)*\n`;
  if (!nextWeekPlan || nextWeekPlan.length === 0) {
    text += `  _(이번 주 등록된 계획이 없습니다.)_\n`;
  } else {
    nextWeekPlan.forEach(task => {
      const cleanTaskName = task.taskName.replace(/[📄@]/g, '').trim();
      const taskLink = task.taskUrl ? `<${task.taskUrl}|${cleanTaskName}>` : cleanTaskName;
      text += `  *🔗 Task: ${taskLink}*\n`;

      task.subItems.forEach(sub => {
        const cleanSubName = sub.itemName.replace(/[📄@]/g, '').trim();
        const wasIncompleteLastWeek = analysisResults.some(lastTask => 
          lastTask.subItems.some(lastSub => !lastSub.isCompleted && lastSub.itemName === sub.itemName)
        );

        if (wasIncompleteLastWeek) {
          text += `    • ${cleanSubName} _(★ 지난주 미완료 이관 보완)_\n`;
        } else {
          text += `    • ${cleanSubName}\n`;
        }
      });
    });
  }

  text += `\n\n`;
  return text;
}

/**
 * 모든 직원의 주간 업무 리포트를 취합하여 지정 채널에 100% 무결점 텍스트 리포트 표로 발송합니다.
 * 또한 수동 캔버스 ID 목록이 설정된 경우, 각 캔버스를 실시간 덮어쓰기(수정) 갱신해 줍니다!
 */
async function sendWeeklyReport({ weekTitle, nextWeekTitle, memberReports, targetChannelName = '스마트팜-workplan', startDate, endDate, skipChannelNotice = false }) {
  try {
    // 1. [초중요 수동 캔버스 ID 실시간 업데이트 동작]
    // config 에 캔버스 ID들이 수동 기입되어 있다면 각 캔버스를 실시간 수정(덮어쓰기)합니다.
    const updatedCanvases = [];
    for (const rep of memberReports) {
      const manualCanvasId = config.slack.canvasIds[rep.memberName];
      if (manualCanvasId) {
        try {
          const res = await updateWeeklyReportCanvas({
            canvasId: manualCanvasId,
            weekTitle,
            nextWeekTitle,
            memberName: rep.memberName,
            analysisResults: rep.analysisResults,
            dailyLogs: rep.dailyLogs,
            nextWeekPlan: rep.nextWeekPlan,
            tasksMap: rep.tasksMap,
            startDate,
            endDate
          });
          updatedCanvases.push({
            memberName: rep.memberName,
            canvasUrl: res.canvasUrl
          });
        } catch (canvasErr) {
          console.error(`  -> '${rep.memberName}' 님의 수동 캔버스(${manualCanvasId}) 실시간 덮어쓰기 업데이트 실패:`, canvasErr.message);
        }
      }
    }

    // 2. 통합 알림 채널 메시지 발송 (skipChannelNotice가 false일 때만 봇 명의로 알림 전송)
    if (!skipChannelNotice && updatedCanvases.length > 0) {
      const channelId = await findChannelIdByName(targetChannelName);
      
      for (let i = 0; i < updatedCanvases.length; i++) {
        const uc = updatedCanvases[i];
        const clean = uc.memberName.replace(' 님', '').trim();
        
        // 실 서비스 배포 시 <!channel> 전체 멘션이 덧붙여집니다.
        const isLast = i === updatedCanvases.length - 1;
        const channelMention = isLast ? ' <!channel>' : '';
        const noticeText = `👤 *[${clean}]* ${weekTitle} 주간 업무 브리핑 캔버스 업데이트 완료 ✅ <${uc.canvasUrl}|바로가기>${channelMention}`;

        await slack.chat.postMessage({
          channel: channelId,
          text: noticeText,
          mrkdwn: true,
          unfurl_links: false,
          unfurl_media: false
        });
        console.log(`  -> 🤖 HANSL 봇이 채널에 '${clean}'의 캔버스 바로가기 알림을 전송 완료했습니다. (마지막 멘션 여부: ${isLast})`);
      }
    } else {
      console.log(`  -> 💡 슬랙 채널 알림 메시지 발송이 옵션(skipChannelNotice)에 의해 생략되었습니다.`);
    }

    console.log(`  -> 🎉 총 ${updatedCanvases.length}명의 수동 개설 캔버스 덮어쓰기 완료!`);
    return updatedCanvases.length > 0;
  } catch (error) {
    console.error('슬랙 리포트 전송 에러:', error);
    throw error;
  }
}

async function sendDirectMessage(userId, text, blocks = null) {
  try {
    const postOptions = {
      channel: userId,
      text: text, // fallback 알림 텍스트
      mrkdwn: true,
      unfurl_links: false,
      unfurl_media: false
    };
    if (blocks) {
      postOptions.blocks = blocks;
    }
    const response = await slack.chat.postMessage(postOptions);
    console.log(`  -> 🎉 HANSL 봇이 대상자(ID: ${userId})에게 1:1 DM 전송에 성공했습니다.`);
    return response;
  } catch (error) {
    console.error(`1:1 DM 발송 실패 (User ID: ${userId}):`, error.message);
    return null;
  }
}

function isImageUrl(url) {
  if (!url) return false;
  try {
    const cleanUrl = url.split(')')[0];
    const pathPart = cleanUrl.split('?')[0].toLowerCase();
    return pathPart.endsWith('.png') || 
           pathPart.endsWith('.jpg') || 
           pathPart.endsWith('.jpeg') || 
           pathPart.endsWith('.gif') || 
           pathPart.endsWith('.webp');
  } catch (e) {
    return false;
  }
}

async function formatLinksInText(text, collectImageUrls = null) {
  if (!text) return '';
  let formatted = text.trim();
  
  // 1. 마크다운 링크 [label](url) 파싱
  const mdRegex = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
  let match;
  const mdMatches = [];
  while ((match = mdRegex.exec(formatted)) !== null) {
    mdMatches.push({
      full: match[0],
      label: match[1],
      url: match[2].endsWith(')') ? match[2].slice(0, -1) : match[2]
    });
  }

  for (const m of mdMatches) {
    if (isImageUrl(m.url) || m.label.includes('이미지') || m.label.includes('사진')) {
      const shortUrl = await getPermanentImageUrl(m.url);
      if (collectImageUrls) {
        collectImageUrls.push({ url: m.url, shortUrl, label: m.label });
      }
      formatted = formatted.replace(m.full, '');
    } else {
      formatted = formatted.replace(m.full, `<${m.url}|${m.label}>`);
    }
  }
  
  // 슬랙 포맷 링크 임시 격리
  const slackLinks = [];
  formatted = formatted.replace(/<https?:\/\/[^\s>|]+\|[^>]+>/g, (match) => {
    slackLinks.push(match);
    return `__SLACK_LINK_PLACEHOLDER_${slackLinks.length - 1}__`;
  });
  formatted = formatted.replace(/<https?:\/\/[^\s>]+>/g, (match) => {
    slackLinks.push(match);
    return `__SLACK_LINK_PLACEHOLDER_${slackLinks.length - 1}__`;
  });
  
  // 2. Raw URL 파싱
  const rawUrlRegex = /<?(https?:\/\/[^\s()<>|]+)>?/g;
  const rawMatches = [];
  while ((match = rawUrlRegex.exec(formatted)) !== null) {
    rawMatches.push({
      full: match[0],
      url: match[1].endsWith(')') ? match[1].slice(0, -1) : match[1]
    });
  }

  for (const m of rawMatches) {
    if (isImageUrl(m.url)) {
      const shortUrl = await getPermanentImageUrl(m.url);
      if (collectImageUrls) {
        collectImageUrls.push({ url: m.url, shortUrl, label: '이미지 첨부' });
      }
      formatted = formatted.replace(m.full, '');
    } else {
      formatted = formatted.replace(m.full, `<${m.url}|바로가기>`);
    }
  }
  
  formatted = formatted.replace(/__SLACK_LINK_PLACEHOLDER_(\d+)__/g, (match, index) => {
    return slackLinks[parseInt(index, 10)];
  });
  
  return formatted;
}

async function sendDailyReport({ date, memberReports, targetUserId }) {
  try {
    const dayLabel = formatDayLabel(date);
    
    // Supabase에서 승인된 출장자 정보 조회
    const approvedTrips = await supabaseService.getApprovedBusinessTrips(date);
    
    // 1. 공통 헤더 메시지 발송 및 실시간 DM 채널 ID 동적 추출
    let headerText = `📢 *[일일 업무 보고 브리핑]* (${dayLabel})\n`;
    headerText += `> 당일 팀원들의 Notion Daily Work Log 취합 요약 브리핑입니다.\n\n`;
    headerText += `---`;
    
    const headerResponse = await sendDirectMessage(targetUserId, headerText);
    if (!headerResponse || !headerResponse.channel) {
      console.error(`헤더 메시지 발송 실패 또는 DM 채널 ID를 획득하지 못했습니다.`);
      return false;
    }
    const realDmChannelId = headerResponse.channel;
    console.log(`  -> 🎉 정현웅 님과의 실시간 DM 채널 ID 동적 확보 성공: ${realDmChannelId}`);

    // [신규] 깃허브 아카이브용 일일 취합 마크다운 빌더 시작
    let dailyArchiveContent = `# 📅 일일 업무 보고 브리핑 (${dayLabel})\n\n`;
    dailyArchiveContent += `> 당일 팀원들의 Notion Daily Work Log 취합 요약 브리핑 히스토리입니다.\n\n---\n\n`;

    // 2. 담당자별로 일지 단위 메시지 전송 (한슬 토글 최적화 및 50개 블록 제한 원천 차단)
    for (const rep of memberReports) {
      const cleanName = rep.memberName.replace(' 님', '').trim();
      const memberEmail = MEMBER_EMAILS[cleanName];
      const isTripFromSupabase = memberEmail && approvedTrips.has(memberEmail);

      let statusLabel = '';
      if (isTripFromSupabase) {
        statusLabel = ' (출장)';
      } else if (rep.dailyLogs && rep.dailyLogs.length > 0) {
        let hasVacation = false;
        let hasMorningHalf = false;
        let hasAfternoonHalf = false;
        let hasHalfDay = false;
        let hasBusinessTrip = false;

        rep.dailyLogs.forEach(log => {
          const t = log.title || '';
          if (t.includes('오전반차') || t.includes('오전 반차')) {
            hasMorningHalf = true;
          } else if (t.includes('오후반차') || t.includes('오후 반차')) {
            hasAfternoonHalf = true;
          } else if (t.includes('반차')) {
            hasHalfDay = true;
          } else if (t.includes('연차')) {
            hasVacation = true;
          } else if (t.includes('출장')) {
            hasBusinessTrip = true;
          }
        });

        if (hasVacation) statusLabel = ' - 연차';
        else if (hasMorningHalf) statusLabel = ' - 오전반차';
        else if (hasAfternoonHalf) statusLabel = ' - 오후반차';
        else if (hasHalfDay) statusLabel = ' - 반차';
        else if (hasBusinessTrip) statusLabel = ' - 출장';
      }

      dailyArchiveContent += `## 👤 ${cleanName} 님${statusLabel}\n\n`;

      // 담당자 헤더 단독 전송
      await slack.chat.postMessage({
        channel: realDmChannelId,
        text: `👤 *${cleanName} 님${statusLabel}*`,
        mrkdwn: true,
        unfurl_links: false
      });
      await new Promise(resolve => setTimeout(resolve, 1500));

      if (!rep.dailyLogs || rep.dailyLogs.length === 0) {
        const emptyText = isTripFromSupabase ? '* _오늘 기록된 일일 업무 일지가 없습니다. (출장)_' : '* _오늘 기록된 일일 업무 일지가 없습니다._';
        dailyArchiveContent += `${emptyText}\n\n`;
        await slack.chat.postMessage({
          channel: realDmChannelId,
          text: emptyText,
          mrkdwn: true,
          unfurl_links: false
        });
        await new Promise(resolve => setTimeout(resolve, 1500));
      } else {
        for (const log of rep.dailyLogs) {
          const isOutsideWork = 
            (log.title && log.title.includes('스마트팜 외 업무')) ||
            log.taskRelations.some(rel => {
              const taskInfo = rep.tasksMap && rep.tasksMap[rel.id];
              return taskInfo && (
                taskInfo.projectName === '스마트팜 외 업무' ||
                taskInfo.name === '스마트팜 외 업무' ||
                (taskInfo.name && taskInfo.name.includes('스마트팜 외 업무'))
              );
            });

          const logBlocks = [];

          if (isOutsideWork) {
            const taskNames = log.taskRelations
              .map(rel => rep.tasksMap[rel.id]?.name)
              .filter(Boolean);
            const taskNameStr = taskNames.length > 0 ? taskNames.join(', ') : '스마트팜 외 업무';
            
            dailyArchiveContent += `* **[${taskNameStr} (스마트팜 외 업무)](${log.url})**\n\n`;

            logBlocks.push({
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: `* <${log.url}|*${taskNameStr} (스마트팜 외 업무)*>`
              }
            });
          } else {
            const cleanTitle = log.title.replace(/[📄@]/g, '').trim();
            dailyArchiveContent += `* **[${cleanTitle}](${log.url})**\n`;

            let logItemText = `* <${log.url}|*${cleanTitle}*>\n`;
            const logImages = [];

            if (log.details && log.details.trim()) {
              const detailLines = log.details.trim().split('\n');
              for (const line of detailLines) {
                if (line.trim()) {
                  const lineImages = [];
                  const formattedLine = await formatLinksInText(line.trim(), lineImages);

                  // 이미지 링크가 제거된 후 남은 텍스트가 유의미하지 않다면 본문 추가를 스킵
                  const cleanLineText = formattedLine.replace(/[•\-\*\s\(\)]/g, '').trim();
                  if (cleanLineText.length === 0) {
                    if (lineImages.length > 0) {
                      for (const img of lineImages) {
                        logImages.push(img);
                      }
                    }
                  } else {
                    dailyArchiveContent += `  - (상세: ${formattedLine.trim()})\n`;
                    
                    // 글자수 제한 체크 (3000자 초과 방지)
                    const appendStr = `  - (상세: ${formattedLine.trim()})\n`;
                    if (logItemText.length + appendStr.length > 2800) {
                      const limitNotice = `\n... (본문이 너무 길어 생략되었습니다. 전체 내용은 노션 링크에서 확인해주세요.)\n`;
                      if (!logItemText.includes(limitNotice)) {
                        logItemText += limitNotice;
                      }
                    } else {
                      logItemText += appendStr;
                    }

                    if (lineImages.length > 0) {
                      for (const img of lineImages) {
                        logImages.push(img);
                      }
                    }
                  }
                }
              }
            }

            logBlocks.push({
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: logItemText
              }
            });

            // 이미지가 존재하는 경우 본문 바로 밑에 image 블록을 배치
            // 한슬 앱은 단일 메시지(section + image)를 인식해 자동으로 (파일크기) ▼ 파일 토글을 생성함
            for (const img of logImages) {
              const shortUrl = img.shortUrl || await getPermanentImageUrl(img.url);
              
              // 깃허브 아카이브용 마크다운에도 이미지 렌더링 태그 추가
              dailyArchiveContent += `\n![${img.label || '이미지 첨부'}](${shortUrl})\n`;

              logBlocks.push({
                type: 'image',
                image_url: shortUrl,
                alt_text: img.label || '이미지 첨부'
              });
            }
            dailyArchiveContent += `\n`;
          }

          // 일지 단위 메시지 개별 전송
          await slack.chat.postMessage({
            channel: realDmChannelId,
            text: `👤 ${cleanName} 님 일지 상세`,
            blocks: logBlocks,
            unfurl_links: false
          });
          await new Promise(resolve => setTimeout(resolve, 1500)); // 레이트 리밋 방지 및 순서 안꼬이게 1.5초 대기
        }
      }

      dailyArchiveContent += `\n---\n\n`;

      // 담당자 구분선 전송
      await slack.chat.postMessage({
        channel: realDmChannelId,
        blocks: [
          {
            type: 'divider'
          }
        ],
        text: '---',
        unfurl_links: false
      });
      await new Promise(resolve => setTimeout(resolve, 1500));
      console.log(`  -> 🎉 '${cleanName} 님'의 일일 보고 분할 메시지 발송 완료!`);
    }

    // [신규] 깃허브 아카이브용 일일 보고서 마크다운 저장
    try {
      const reportDir = path.join(__dirname, '../../docs/daily-reports');
      if (!fs.existsSync(reportDir)) {
        fs.mkdirSync(reportDir, { recursive: true });
      }
      const filename = `${date}.md`;
      const savePath = path.join(reportDir, filename);
      
      fs.writeFileSync(savePath, dailyArchiveContent, 'utf8');
      console.log(`  -> 📂 [마크다운 저장] 일일 보고서 파일 기록 성공: docs/daily-reports/${filename}`);
    } catch (fsErr) {
      console.warn(`  -> ⚠️ 일일 보고서 파일 저장 실패 (계속 진행):`, fsErr.message);
    }

    return true;
  } catch (error) {
    console.error('일일 업무 브리핑 DM 전송 실패:', error.message);
    return false;
  }
}

async function findUserIdByEmail(email) {
  const cleanEmail = email.trim().toLowerCase();
  if (userIdCache[cleanEmail]) {
    return userIdCache[cleanEmail];
  }
  try {
    const response = await slack.users.lookupByEmail({ email: cleanEmail });
    if (response.ok && response.user?.id) {
      userIdCache[cleanEmail] = response.user.id;
      return response.user.id;
    }
  } catch (error) {
    console.error(`[Slack] 이메일 기준 유저 ID 조회 실패 (${cleanEmail}):`, error.message);
  }
  return null;
}

async function sendChannelReminder({ mentionIds, targetChannelName = '스마트팜-workplan' }) {
  try {
    if (!mentionIds || mentionIds.length === 0) {
      console.log(`[Slack] 독려 대상자가 없어 채널 메시지 발송을 생략합니다.`);
      return false;
    }

    const channelId = await findChannelIdByName(targetChannelName);
    const mentionsText = mentionIds.map(id => `<@${id}>`).join(' ');
    const messageText = `금일 데일리 워크로그 작성 부탁드립니다! ${mentionsText}`;

    await slack.chat.postMessage({
      channel: channelId,
      text: messageText,
      mrkdwn: true,
      unfurl_links: false,
      unfurl_media: false
    });

    console.log(`  -> 🎉 슬랙 채널(#${targetChannelName})로 일지 작성 독려 메시지 전송 성공! (멘션 대상: ${mentionIds.join(', ')})`);
    return true;
  } catch (error) {
    console.error(`[Slack] 채널 독려 메시지 전송 실패:`, error.message);
    return false;
  }
}

module.exports = {
  findChannelIdByName,
  sendWeeklyReport,
  sendDirectMessage,
  sendDailyReport,
  findUserIdByEmail,
  sendChannelReminder,
  MEMBER_EMAILS
};
