require('dotenv').config();

module.exports = {
  notion: {
    token: process.env.NOTION_TOKEN,
    db: {
      weeklyPlan: process.env.NOTION_WEEKLY_PLAN_DB_ID || '36bc640c-cca4-80d5-b0d1-e7171d54f184',
      dailyWorkLog: process.env.NOTION_DAILY_WORK_LOG_DB_ID || '1c3c640c-cca4-8370-9509-019c4a379b92',
      tasks: process.env.NOTION_TASKS_DB_ID || '7eec640c-cca4-82a5-aba5-81fe3b052b93',
      teamMembers: process.env.NOTION_TEAM_MEMBERS_DB_ID || '4b7c640c-cca4-82ba-99cc-817c501e7fa4',
      projects: process.env.NOTION_PROJECTS_DB_ID || 'd24c640c-cca4-8278-b12e-81dc5c4e7a51'
    }
  },
  slack: {
    token: process.env.SLACK_BOT_TOKEN,
    userToken: process.env.SLACK_USER_TOKEN, // 정현웅 님 유저 권한 토큰
    teamId: process.env.SLACK_TEAM_ID || 'T0B2QAU647J', // 슬랙 팀 ID
    channelId: process.env.SLACK_CHANNEL_ID || 'C0B78V66EBX', // 기본 스마트팜-workplan ID
    adminUserId: process.env.SLACK_ADMIN_USER_ID || 'U0B1U11SBE2', // 정현웅 님 슬랙 User ID 백업용
    canvasIds: {
      '김윤회': process.env.SLACK_CANVAS_ID_YUNHUI || '',
      '김희승': process.env.SLACK_CANVAS_ID_HEESEUNG || '',
      '최현빈': process.env.SLACK_CANVAS_ID_HYUNBIN || ''
    }
  },
  supabase: {
    url: process.env.SUPABASE_URL || 'https://qvhbigvdfyvhoegkhvef.supabase.co',
    key: process.env.SUPABASE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InF2aGJpZ3ZkZnl2aG9lZ2todmVmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDc4MTQzNjAsImV4cCI6MjA2MzM5MDM2MH0.7VZlSwnNuE0MaQpDjuzeZFgjJrDBQOWA_COyqaM8Rbg'
  }
};
