// 與 platform/api/app/imaging 的回應形狀一致（service.py 的 job_to_dict、studies_to_dicts、list_files）。

export interface SeriesSummary {
  series_instance_uid: string;
  modality: string | null;
  series_description: string | null;
  instances: number;
}

export interface Study {
  study_instance_uid: string;
  accession_number: string | null;
  patient_id: string | null;
  patient_sex: string | null;
  study_date: string | null;
  study_description: string | null;
  modalities: string[];
  series: SeriesSummary[];
  instances: number;
}

export type FileStatus = 'imported' | 'duplicate' | 'failed';
export type ImportStatus = 'succeeded' | 'partial' | 'failed';
export type ImportKind = 'dicom' | 'files' | 'pacs';

export interface ImportFileResult {
  filename: string;
  status: FileStatus;
  reason: string;
}

export interface ImportJob {
  id: number;
  kind: ImportKind;
  status: ImportStatus;
  created_by: string;
  created_at: string;
  counts: Record<FileStatus, number>;
  files?: ImportFileResult[];
}

export interface ImagingFile {
  id: number;
  filename: string;
  format: 'nifti' | 'itk' | 'makesense';
  role: 'image' | 'label';
  case: string | null;
  meta: Record<string, unknown>;
  pairing: 'n/a' | 'paired' | 'unpaired';
  pairing_note: string;
  paired_image: string | null;
  paired_sop_instance_uids: string[];
}

export interface Allowlist {
  accession_numbers: string[];
}

/** PACS C-FIND 的回答（Study 層級），鍵為 DICOM 標籤名稱 */
export interface PacsAnswer {
  StudyInstanceUID: string;
  AccessionNumber?: string;
  PatientID?: string;
  PatientSex?: string;
  StudyDate?: string;
  StudyDescription?: string;
  ModalitiesInStudy?: string;
  Modality?: string;
  NumberOfStudyRelatedSeries?: string;
  NumberOfStudyRelatedInstances?: string;
}

export interface StudyFilters {
  modality: string;
  patient_sex: string;
  study_description: string;
  study_date: string;
  series_description: string;
}

export const EMPTY_FILTERS: StudyFilters = {
  modality: '',
  patient_sex: '',
  study_description: '',
  study_date: '',
  series_description: '',
};

export const FILE_STATUS_LABELS: Record<FileStatus, string> = { imported: '已匯入', duplicate: '重複', failed: '失敗' };
export const IMPORT_STATUS_LABELS: Record<ImportStatus, string> = { succeeded: '全部成功', partial: '部分失敗', failed: '全部失敗' };
export const IMPORT_KIND_LABELS: Record<ImportKind, string> = { dicom: 'DICOM 上傳', files: 'NIfTI／ITK／makesense', pacs: 'PACS 取像' };
export const FORMAT_LABELS: Record<ImagingFile['format'], string> = { nifti: 'NIfTI', itk: 'ITK（.mha）', makesense: 'makesense' };
export const PAIRING_LABELS: Record<ImagingFile['pairing'], string> = { 'n/a': '影像（不需配對）', paired: '已配對', unpaired: '未配對' };
export const SEX_LABELS: Record<string, string> = { F: '女（F）', M: '男（M）', O: '其他（O）' };
