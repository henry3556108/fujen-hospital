// 由 platform/deploy/k8s/render-config.py 從 platform/deploy/local/ohif/app-config.js 產生
/** OHIF 檢視器設定（WP5a）。所有值都是本機測試值；甲方環境要換成正式網域。
 *
 * - 資料來源只有一個：Gateway 的專案範圍 DICOMweb `/dicomweb/projects/{pid}`。
 *   專案由網址的 `project` 參數決定，例：/viewer?StudyInstanceUIDs=<uid>&project=1
 *   Accession 清單、專案成員資格都由 Gateway 的 forward-auth 檢查，OHIF 自己不做判斷。
 * - 不顯示研究清單：平台的 DICOMweb 不開放列表搜尋，研究一律從平台的標註頁開啟。
 * - 登入：Keycloak OIDC（與平台同一個 realm，已登入平台的瀏覽器不需再輸入密碼）。
 * - 器官窗與快捷鍵沿用 OHIF 內建：CT 有軟組織、肺、骨、腦等窗位（數字鍵 1–4），
 *   r／l 旋轉、h／v 翻轉、i 反相、上下鍵換張、空白鍵重設。
 */
window.config = {
  name: 'ai-platform',
  routerBasename: null,
  extensions: [],
  modes: [],
  customizationService: {},
  showStudyList: false,
  maxNumberOfWebWorkers: 3,
  showWarningMessageForCrossOrigin: false,
  showCPUFallbackMessage: true,
  showLoadingIndicator: true,
  strictZSpacingForVolumeViewport: true,
  showErrorDetails: 'dev',
  oidc: [
    {
      authority: 'https://KEYCLOAK_HOST/realms/ai-platform',
      client_id: 'ai-platform-ohif',
      redirect_uri: '/callback',
      response_type: 'code',
      scope: 'openid',
      post_logout_redirect_uri: '/logout-redirect.html',
      automaticSilentRenew: true,
      revokeAccessTokenOnSignout: true,
    },
  ],
  defaultDataSourceName: 'platform',
  dataSources: [
    {
      namespace: '@ohif/extension-default.dataSourcesModule.dicomweb',
      sourceName: 'platform',
      configuration: {
        friendlyName: 'AI Platform 專案影像',
        name: 'platform',
        // 先填不存在的專案 0；實際位址由 onConfiguration 依網址的 project 參數決定
        wadoUriRoot: '/dicomweb/projects/0',
        qidoRoot: '/dicomweb/projects/0',
        wadoRoot: '/dicomweb/projects/0',
        qidoSupportsIncludeField: false,
        imageRendering: 'wadors',
        thumbnailRendering: 'wadors',
        enableStudyLazyLoad: true,
        supportsFuzzyMatching: false,
        supportsWildcard: false,
        staticWado: false,
        singlepart: 'bulkdata,video',
        bulkDataURI: { enabled: true, relativeResolution: 'studies' },
        omitQuotationForMultipartRequest: true,
        onConfiguration: (config, options) => {
          const project = (options && options.query && options.query.get('project')) || '';
          const pid = /^[0-9]+$/.test(project) ? project : '0';
          const root = `${window.location.origin}/dicomweb/projects/${pid}`;
          return { ...config, wadoUriRoot: root, qidoRoot: root, wadoRoot: root };
        },
      },
    },
  ],
};
