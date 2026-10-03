import { Alert } from '../../components/Alert';
import type { ValidationReport } from './types';

/** 上傳驗證報告：被拒絕的列逐筆列出欄位與原因（TC-B01-10）。 */
export function ReportView({ report, title }: { report: ValidationReport; title: string }) {
  const clean = report.rejected_row_count === 0;
  const dropped = report.warnings.some((w) => typeof w !== 'string' && w.code === 'unknown_columns');
  const failed = report.errors.length > 0;
  const tone = failed ? 'error' : clean && !dropped ? 'success' : 'warning';
  const heading = failed ? '檔案無法使用' : !clean ? '部分資料列被拒絕' : dropped ? '資料列全部通過，但有欄位沒有進入資料集' : '全部通過';
  return (
    <section className="section" aria-label={title}>
      <h3>{title}</h3>
      <Alert tone={tone} title={heading}>
        {failed ? report.errors.map((e) => e.message).join('；') : `共 ${report.total_rows} 列，通過 ${report.valid_rows} 列，拒絕 ${report.rejected_row_count} 列。`}
        {!failed && !clean && '被拒絕的列不會進入資料集。'}
      </Alert>
      {report.warnings.length > 0 && (
        <Alert tone={dropped ? 'warning' : 'info'} title="提醒">
          {report.warnings.map((w) => (typeof w === 'string' ? w : w.message)).join('；')}
        </Alert>
      )}
      {!clean && (
        <div className="table-wrap">
          <table aria-label={`${title}：被拒絕的資料列`}>
            <thead>
              <tr>
                <th scope="col" className="num">
                  資料列（從 0 起算）
                </th>
                <th scope="col" className="num">
                  檔案行號
                </th>
                <th scope="col">欄位</th>
                <th scope="col">原因</th>
              </tr>
            </thead>
            <tbody>
              {report.rejected.map((r, i) => (
                <tr key={`${r.row}-${i}`}>
                  <th scope="row" className="num">
                    {r.row}
                  </th>
                  <td className="num">{r.row + 2}</td>
                  <td>{r.column || '—'}</td>
                  <td>{r.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
