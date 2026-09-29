import type { Permission } from '../../api/types';
import { PERMISSION_LABELS } from '../../api/types';
import { useMe, useSession } from '../../auth/SessionContext';

/** 目前專案的權限判斷（Admin 視為全部都有）。頁面用它決定要顯示表單還是「沒有權限」說明。 */
export function useProjectAccess() {
  const me = useMe();
  const { project } = useSession();
  const isAdmin = me.account_type === 'admin';
  const can = (permission: Permission) => isAdmin || (project?.permissions.includes(permission) ?? false);
  const missing = (permission: Permission, action: string) =>
    `你在專案「${project?.name ?? ''}」沒有 ${PERMISSION_LABELS[permission]} 權限，無法${action}。`;
  return { me, project, isAdmin, can, missing };
}
