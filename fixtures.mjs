// 시각은 실행 기준일(KST)로부터 며칠 전 몇 시(KST)인지로 적는다.
// expect 는 정책 문서 기준의 기대 결과다.
//   keep            첨부 유지
//   purge           첨부 정리, 파일 삭제
//   purge-keep-file 이벤트에서는 정리, 보고서가 쓰는 파일은 보존
// 경계 건(INC-1002, INC-1003)의 expect 는 같은 날 00:30~23:30 사이에 채점할 때만 성립한다.

export const fixtures = [
  {
    id: 'INC-1015', title: '정산 리포트 생성 실패', service: 'settlement-report', file: 'settlement-report.log',
    message: 'report renderer exited with code 137',
    created: [30, '12:20'], closed: [30, '13:00'], expect: 'purge', note: '오래된 정리 대상',
  },
  {
    id: 'INC-1005', title: '알림 발송 큐 적체', service: 'notification-worker', file: 'notification-queue.log',
    message: 'queue depth exceeded 50000 messages',
    created: [28, '09:12'], closed: [28, '11:00'], expect: 'purge', note: '정리 대상',
  },
  {
    id: 'INC-1007', title: '검색 인덱스 재구축 실패', service: 'search-indexer', file: 'search-reindex.log',
    message: 'shard allocation failed on node search-2',
    created: [25, '08:30'], closed: null, expect: 'keep', note: '미처리 — 등록일이 오래돼도 유지',
  },
  {
    id: 'INC-1012', title: '로그 수집기 디스크 경고', service: 'log-collector', file: 'log-collector-disk.log',
    message: 'disk usage reached 92% on /var/lib/collector',
    created: [22, '19:40'], closed: [22, '20:15'], expect: 'purge', note: '정리 대상',
  },
  {
    id: 'INC-1006', title: '주문 동기화 누락', service: 'order-sync', file: 'order-sync.log',
    message: '37 orders missing after partner sync',
    created: [20, '17:02'], closed: [20, '18:40'], report: 'AUD-2001', expect: 'purge-keep-file',
    note: '감사 보고서가 같은 파일 사용',
  },
  {
    id: 'INC-1008', title: '개인정보 접근 로그 이상', service: 'privacy-audit', file: 'privacy-access.log',
    message: 'bulk export by service account outside approved window',
    created: [18, '13:45'], closed: [18, '15:10'], legalHold: true, expect: 'keep', note: '법적 보존',
  },
  {
    id: 'INC-1004', title: '결제 API 응답 지연', service: 'payments-api', file: 'payments-gateway.log',
    message: 'upstream response timeout after 3000ms',
    created: [15, '14:55'], closed: [15, '16:20'], expect: 'purge', note: '정리 대상',
  },
  {
    id: 'INC-1002', title: '백업 작업 지연', service: 'backup-worker', file: 'backup-worker.log',
    message: 'snapshot queue exceeded threshold',
    created: [15, '22:10'], closed: [14, '00:30'], expect: 'purge', note: '경계 — 336시간 경과 (날짜 차이는 14일)',
  },
  {
    id: 'INC-1003', title: '인증 토큰 갱신 실패', service: 'auth-service', file: 'auth-refresh.log',
    message: 'refresh token endpoint returned 503',
    created: [14, '21:05'], closed: [14, '23:30'], expect: 'keep', note: '경계 — 날짜 차이는 14일이지만 336시간 미만',
  },
  {
    id: 'INC-1001', title: '정산 배치 재시도', service: 'settlement', file: 'settlement-batch.log',
    message: 'batch attempt exceeded timeout',
    created: [13, '07:40'], closed: [13, '10:00'], expect: 'keep', note: '기준 미달',
  },
  {
    id: 'INC-1013', title: '배치 스케줄러 중복 실행', service: 'batch-scheduler', file: 'batch-scheduler.log',
    message: 'job settlement-daily started twice within 2s',
    created: [10, '16:45'], closed: null, expect: 'keep', note: '미처리',
  },
  {
    id: 'INC-1014', title: '세션 저장소 연결 끊김', service: 'session-store', file: 'session-store.log',
    message: 'connection reset by peer (redis-session-1)',
    created: [9, '10:50'], closed: [9, '11:25'], expect: 'keep', note: '기준 미달',
  },
  {
    id: 'INC-1011', title: '재고 API 타임아웃', service: 'inventory-api', file: 'inventory-api.log',
    message: 'read timeout after 5000ms on /stock',
    created: [6, '13:10'], closed: [6, '14:30'], report: 'AUD-2002', expect: 'keep', note: '보고서 연결, 기준 미달',
  },
  {
    id: 'INC-1009', title: 'CDN 캐시 무효화 지연', service: 'cdn-purger', file: 'cdn-purge.log',
    message: 'invalidation pending for 1240s',
    created: [3, '10:20'], closed: null, expect: 'keep', note: '미처리',
  },
  {
    id: 'INC-1010', title: '메일 서버 인증 오류', service: 'mail-relay', file: 'mail-relay.log',
    message: 'SMTP AUTH failed for relay account',
    created: [2, '09:05'], closed: [2, '09:50'], expect: 'keep', note: '기준 미달',
  },
]
