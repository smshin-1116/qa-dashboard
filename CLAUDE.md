# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 프로젝트 개요

Next.js 15, React 19, TypeScript로 구축된 한국어 QA 도구입니다. Confluence 문서를 분석하여 AI 기반으로 포괄적인 테스트 케이스를 자동 생성하는 애플리케이션입니다. Gemini AI를 우선 사용하고 실패 시 OpenAI로 자동 fallback하는 이중 AI 시스템을 구현했습니다.

## 개발 명령어

- `npm run dev` - Turbopack으로 개발 서버 시작 (http://localhost:3000에서 실행)
- `npm run build` - 프로덕션 애플리케이션 빌드 및 타입 검증
- `npm run start` - 프로덕션 서버 시작
- `npm run lint` - Next.js TypeScript 규칙으로 ESLint 실행

## 아키텍처

### AI 분석 시스템 (`lib/gemini-analyzer.ts`)
핵심 AI 분석 엔진으로 다음 기능을 제공:
- **이중 AI 시스템**: Gemini AI 우선 → OpenAI 자동 fallback
- **문서 분석**: `analyzeConfluenceContent()` - 요구사항, 사용자 스토리, 비즈니스 룰 등 추출
- **테스트 케이스 생성**: `generateTestCasesFromAnalysis()` - 분석 결과 기반 체계적 테스트 케이스 생성
- **JSON 파싱**: 안전한 JSON 정리 및 파싱 함수로 AI 응답 처리
- **타입 안전성**: TypeScript strict 모드로 모든 함수 타입 보장

### API 라우트 시스템
#### Confluence API (`app/api/confluence/route.ts`)
- Confluence REST API 연동으로 페이지 내용 추출
- AI 분석 파이프라인 실행
- 사용된 AI 모델 정보 포함한 통합 응답 반환

#### Figma API (`app/api/figma/route.ts`)
- 현재 기본 구조 완성, 향후 AI 분석 확장 예정
- Figma API 연동 및 Mock 테스트 케이스 생성
- UI/UX 일관성 검증 테스트 케이스 제공

### 컴포넌트 구조
#### 테스트 케이스 생성 플로우
1. **TestcaseGenerationForm**: 메인 입력 폼 (Confluence URL 필수, Figma는 현재 비활성화)
2. **ConfluenceURLForm**: Confluence URL 입력 및 유효성 검사
3. **FigmaURLForm**: 향후 활성화 예정 (현재 disabled 상태)
4. **TestcaseResults**: AI 분석 결과 및 생성된 테스트 케이스 표시
5. **TestcaseItem**: 개별 테스트 케이스 아이템 (Excel 다운로드 포함)

#### UI/네비게이션
- **Sidebar**: 클라이언트 사이드 네비게이션 with active 상태 추적
- **URLForm**: 단순 URL 입력 폼 (홈페이지용)

### 데이터 흐름 및 상태 관리
- **AI 분석 결과**: requirements, userStories, businessRules, functionalRequirements, nonFunctionalRequirements, testScenarios, riskAreas, summary
- **테스트 케이스 상태**: loading, success, error with 실시간 업데이트
- **AI 모델 추적**: 실제 사용된 AI (Gemini/OpenAI) 정보 UI에 표시
- **다국어**: 한국어 중심 (date-fns 한국어 로케일 사용)

## 환경변수 설정

`.env.local` 파일에 다음 변수 설정 필요:

### AI API 키 (최소 하나 필수)
```
OPENAI_API_KEY=your_openai_api_key_here
GOOGLE_AI_API_KEY=your_gemini_api_key_here  # 선택사항
```

### Confluence 연동 (필수)
```
CONFLUENCE_API_TOKEN=your_confluence_token
CONFLUENCE_EMAIL=your_email@company.com
CONFLUENCE_BASE_URL=https://company.atlassian.net
```

### Figma 연동 (향후 사용)
```
FIGMA_ACCESS_TOKEN=your_figma_token  # 현재 선택사항
```

## 중요 구현 원칙

### AI Fallback 시스템
- Gemini AI 우선 시도, 실패 시 OpenAI 자동 전환
- 각 AI 모델별 최적화된 프롬프트 및 파라미터 사용
- 사용된 AI 모델 정보를 응답에 포함하여 UI에 표시

### TypeScript 엄격성
- 모든 `any` 타입 금지, `unknown` 사용
- 인터페이스 타입 일치성 보장
- 환경변수 접근 시 null 체크 필수

### 에러 처리
- JSON 파싱 실패 시 fallback 데이터 제공
- API 오류 시 명확한 한국어 오류 메시지
- 네트워크 오류 및 AI 서비스 장애 대응

### 한국어 최적화
- 모든 UI 텍스트 한국어
- AI 프롬프트 한국어로 최적화
- date-fns 한국어 로케일 사용
- HTML lang="ko" 설정

## 설정 및 도구

- **TypeScript**: Strict 모드, `@/*` 경로 별칭
- **ESLint**: Next.js + TypeScript 규칙, `any` 타입 금지
- **Tailwind CSS**: 한국어 친화적 디자인 시스템
- **Turbopack**: 빠른 개발 빌드
- **Dependencies**: Gemini AI SDK, OpenAI SDK, date-fns