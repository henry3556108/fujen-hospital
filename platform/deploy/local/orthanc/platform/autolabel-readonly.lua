-- 自動標註轉接服務（platform/autolabel/adapter）的服務帳號 autolabel 只能讀 DICOMweb：
-- 只允許 GET /dicom-web/...（QIDO-RS 查影像、WADO-RS 取序列），其他方法與 REST 路徑一律拒絕（403）。
-- 其他帳號（platform-api、gateway）不受影響。Orthanc 內建的帳號沒有權限區分，所以用這個過濾器限制。
function IncomingHttpRequestFilter(method, uri, ip, username, httpHeaders)
  if username == 'autolabel' then
    return method == 'GET' and string.sub(uri, 1, 11) == '/dicom-web/'
  end
  return true
end
