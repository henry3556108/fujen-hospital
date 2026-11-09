// 模型名稱：顯示名稱（部署時取的名稱）在前，模型名稱（技術名稱）以小字附在後面。
import './inference.css';
import { displayName, technicalName, type Model } from './api';

export function ModelName({ model }: { model: Pick<Model, 'name' | 'title'> }) {
  const tech = technicalName(model);
  return (
    <>
      {displayName(model)}
      {tech ? <small className="model-tech-name">（模型名稱：{tech}）</small> : null}
    </>
  );
}
