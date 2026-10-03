// 檔案選擇：瀏覽器內建的按鈕文字依作業系統語言（常見英文「Choose File」），這裡改成中文按鈕「選擇檔案」，
// 旁邊列出已選的檔名。真正的 <input type="file"> 仍在（隱藏、與原本的 <label> 相連），測試與鍵盤操作不變。
import { forwardRef, useImperativeHandle, useRef, useState, type InputHTMLAttributes } from 'react';

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'onChange'> & {
  id: string;
  onFiles: (files: File[]) => void;
  /** 由外部控制顯示的檔名（例如上傳完成後清空）；省略時顯示最後一次選的檔案 */
  fileNames?: string[];
  /** 按鈕文字，預設「選擇檔案」 */
  buttonText?: string;
};

export const FileInput = forwardRef<HTMLInputElement, Props>(function FileInput(
  { id, onFiles, fileNames, buttonText = '選擇檔案', className: _className, ...rest },
  ref,
) {
  const input = useRef<HTMLInputElement>(null);
  useImperativeHandle(ref, () => input.current!);
  const [chosen, setChosen] = useState<string[]>([]);
  const names = fileNames ?? chosen;
  return (
    <span className="file-picker">
      <input
        {...rest}
        ref={input}
        id={id}
        type="file"
        className="visually-hidden"
        tabIndex={-1}
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          setChosen(files.map((f) => f.name));
          onFiles(files);
        }}
      />
      <button type="button" className="btn btn--secondary btn--small" aria-describedby={`${id}-chosen`} onClick={() => input.current?.click()}>
        {buttonText}
      </button>
      <span id={`${id}-chosen`} className="file-picker__names">
        {names.length ? names.join('、') : '尚未選擇檔案'}
      </span>
    </span>
  );
});
