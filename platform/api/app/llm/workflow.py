"""LangGraph 工作流：以 JSON 定義節點與連線，平台組成 StateGraph 執行，逐節點留下紀錄。

狀態是一個字典（定義裡的 state 是初始值，執行時的 input 覆蓋同名欄位）；每個節點讀狀態、寫回自己的 output 欄位。
LangGraph 以 checkpointer 保存每一步的狀態；平台另外把每個節點的輸入狀態、寫回的欄位、LLM 請求與回應存進資料庫。
`continue_from` 可以接著前一次執行的最終狀態繼續跑（多輪流程）。

節點種類：
  template   把樣板（{欄位}）填好寫進 output
  retrieve   以 query 檢索知識庫，結果寫進 output
  wiki       以 Wiki API 取一頁文件，內容寫進 output
  llm        把 prompt 交給模型，回答寫進 output；context 指到的欄位會當成參考資料
  condition  依狀態決定下一個節點（then／else）
"""
import re
from typing import Annotated, TypedDict

from langgraph.checkpoint.memory import MemorySaver
from langgraph.errors import GraphRecursionError
from langgraph.graph import END, START, StateGraph
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.audit import AuditCategory, record
from app.llm import knowledge, prompts
from app.llm.calls import call_llm
from app.llm.chat import choose_model
from app.llm.client import LlmError
from app.llm.errors import Conflict, Invalid, LlmServiceError, NotFound
from app.llm.models import LlmCallRecord, Workflow, WorkflowNodeRecord, WorkflowRun
from app.llm.params import to_openai
from app.llm.services import LlmServices
from app.models import utcnow
from app.llm.util import iso

NODE_TYPES = ("template", "retrieve", "wiki", "llm", "condition")
OPERATORS = ("contains", "equals", "not_empty")
MAX_NODES = 50
MAX_STEPS = 50
END_NAME = "END"
_ID = re.compile(r"^[A-Za-z][A-Za-z0-9_-]{0,63}$")
_KEY = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,63}$")
_PLACEHOLDER = re.compile(r"\{([A-Za-z_][A-Za-z0-9_]*)\}")
_PROVENANCE = "_context_sources"     # 狀態裡記錄各欄位脈絡來源的保留欄位


def render(template: str, state: dict) -> str:
    """只做 {欄位} 取代，不用 str.format（避免存取屬性或索引）。"""
    return _PLACEHOLDER.sub(lambda m: str(state.get(m.group(1), "")), template)


def placeholders(template: str) -> set[str]:
    return set(_PLACEHOLDER.findall(template))


# ---------------------------------------------------------------- 定義驗證

def validate(session: Session, *, project_id: int, definition: dict) -> dict:
    """回傳整理過的定義；有問題丟 Invalid，訊息指出是哪個節點。"""
    if not isinstance(definition, dict):
        raise Invalid("工作流定義必須是物件")
    state = definition.get("state") or {}
    nodes = definition.get("nodes")
    edges = definition.get("edges") or []
    if not isinstance(state, dict) or any(not isinstance(k, str) or not _KEY.match(k) for k in state):
        raise Invalid("state 必須是物件，欄位名稱只能用英數字與底線")
    if any(k.startswith("_") for k in state):
        raise Invalid("state 的欄位名稱不可以底線開頭")
    if not isinstance(nodes, list) or not nodes:
        raise Invalid("工作流至少要有一個節點")
    if len(nodes) > MAX_NODES:
        raise Invalid(f"節點數量上限 {MAX_NODES}")

    ids: list[str] = []
    for node in nodes:
        if not isinstance(node, dict) or not isinstance(node.get("id"), str) or not _ID.match(node["id"]):
            raise Invalid("每個節點都要有 id（英文字母開頭，可用英數字、底線、連字號）")
        if node["id"] in (END_NAME, "START") or node["id"].startswith("__"):
            raise Invalid(f"節點 id 不可使用保留字：{node['id']}")
        if node["id"] in ids:
            raise Invalid(f"節點 id 重複：{node['id']}")
        ids.append(node["id"])
        if node.get("type") not in NODE_TYPES:
            raise Invalid(f"節點 {node['id']} 的種類不認得（可用：{'、'.join(NODE_TYPES)}）")

    outputs = {n["output"] for n in nodes if isinstance(n.get("output"), str)}
    known = set(state) | outputs

    def need(node, field, kind=str):
        value = node.get(field)
        if not isinstance(value, kind) or (kind is str and not value.strip()):
            raise Invalid(f"節點 {node['id']} 缺少 {field}")
        return value

    def check_text(node, field):
        unknown = placeholders(need(node, field)) - known
        if unknown:
            raise Invalid(f"節點 {node['id']} 的 {field} 用到未定義的欄位：{'、'.join(sorted(unknown))}")

    def check_target(node, field):
        target = need(node, field)
        if target != END_NAME and target not in ids:
            raise Invalid(f"節點 {node['id']} 的 {field} 指向不存在的節點：{target}")

    for node in nodes:
        kind = node["type"]
        if kind != "condition":
            output = need(node, "output")
            if not _KEY.match(output) or output.startswith("_"):
                raise Invalid(f"節點 {node['id']} 的 output 名稱不合法")
        if kind == "template":
            check_text(node, "template")
        elif kind == "retrieve":
            check_text(node, "query")
            knowledge.get_kb(session, project_id=project_id, kb_id=need(node, "kb_id", int))
            if not 1 <= node.get("top_k", 3) <= 20:
                raise Invalid(f"節點 {node['id']} 的 top_k 需在 1 到 20 之間")
        elif kind == "wiki":
            if not isinstance(node.get("page_id"), int):
                raise Invalid(f"節點 {node['id']} 缺少 page_id")
        elif kind == "llm":
            check_text(node, "prompt")
            if node.get("system") is not None:
                check_text(node, "system")
            if node.get("context") is not None and node["context"] not in known:
                raise Invalid(f"節點 {node['id']} 的 context 指向未定義的欄位：{node['context']}")
        elif kind == "condition":
            if need(node, "key") not in known:
                raise Invalid(f"節點 {node['id']} 的 key 指向未定義的欄位：{node['key']}")
            if node.get("operator") not in OPERATORS:
                raise Invalid(f"節點 {node['id']} 的 operator 只能是 {'、'.join(OPERATORS)}")
            if node["operator"] != "not_empty" and not isinstance(node.get("value"), str):
                raise Invalid(f"節點 {node['id']} 缺少 value")
            check_target(node, "then")
            check_target(node, "else")

    types = {n["id"]: n["type"] for n in nodes}
    following: dict[str, str] = {}
    for edge in edges:
        if not (isinstance(edge, list) and len(edge) == 2 and all(isinstance(e, str) for e in edge)):
            raise Invalid("edges 的每一項必須是 [來源, 目的]")
        source, target = edge
        if source not in ids or (target != END_NAME and target not in ids):
            raise Invalid(f"連線指向不存在的節點：{source} → {target}")
        if types[source] == "condition":
            raise Invalid(f"條件節點 {source} 的去向由 then／else 決定，不能另外連線")
        if source in following:
            raise Invalid(f"節點 {source} 有一條以上的連線；分支請用條件節點")
        following[source] = target

    entry = definition.get("entry") or ids[0]
    if entry not in ids:
        raise Invalid(f"entry 指向不存在的節點：{entry}")

    reachable, stack = set(), [entry]
    while stack:
        current = stack.pop()
        if current == END_NAME or current in reachable:
            continue
        reachable.add(current)
        node = next(n for n in nodes if n["id"] == current)
        stack += [node["then"], node["else"]] if node["type"] == "condition" else [following.get(current, END_NAME)]
    unreachable = [i for i in ids if i not in reachable]
    if unreachable:
        raise Invalid(f"從 entry 走不到這些節點：{'、'.join(unreachable)}")

    return {"state": state, "entry": entry, "nodes": nodes,
            "edges": [[source, following.get(source, END_NAME)] for source in ids if types[source] != "condition"]}


# ---------------------------------------------------------------- 執行

def _merge(old: dict, new: dict) -> dict:
    return {**old, **new}


class GraphState(TypedDict, total=False):
    values: Annotated[dict, _merge]


class _NodeFailed(Exception):
    def __init__(self, node: str, error: Exception):
        super().__init__(str(error))
        self.node, self.error = node, error


def _public(state: dict) -> dict:
    return {k: v for k, v in state.items() if not k.startswith("_")}


class _Runner:
    def __init__(self, session: Session, services: LlmServices, *, run: WorkflowRun, model: str, params: dict,
                 system_prompt: str):
        self.session, self.services, self.run = session, services, run
        self.model, self.params, self.system_prompt = model, params, system_prompt
        self.seq = 0

    def wrap(self, node: dict):
        def step(graph_state: GraphState) -> dict:
            state = dict(graph_state.get("values") or {})
            self.seq += 1
            entry = WorkflowNodeRecord(run_id=self.run.id, seq=self.seq, node=node["id"], type=node["type"],
                                       status="running", state_in=_public(state), state_out={})
            self.session.add(entry)
            try:
                update, call_id = getattr(self, f"_{node['type']}")(node, state)
            except (LlmError, LlmServiceError) as exc:
                entry.status, entry.error, entry.finished_at = "failed", str(exc)[:512], utcnow()
                if isinstance(exc, LlmError):
                    # call_llm 失敗時已把呼叫紀錄 commit；這裡把它掛回節點紀錄
                    failed = self.session.scalar(select(LlmCallRecord).where(
                        LlmCallRecord.origin_ref == self._ref(node)).order_by(LlmCallRecord.id.desc()))
                    entry.call_id = failed.id if failed else None
                    self.session.add(entry)
                raise _NodeFailed(node["id"], exc)
            entry.status, entry.state_out, entry.call_id = "succeeded", _public(update), call_id
            entry.finished_at = utcnow()
            self.session.flush()
            return {"values": update}
        return step

    def _ref(self, node: dict) -> str:
        return f"workflow-run:{self.run.id}:{node['id']}"

    def _template(self, node, state):
        return {node["output"]: render(node["template"], state)}, None

    def _condition(self, node, state):
        return {}, None

    def _retrieve(self, node, state):
        kb = knowledge.get_kb(self.session, project_id=self.run.project_id, kb_id=node["kb_id"])
        hits = knowledge.search(self.session, self.services, kb=kb, query=render(node["query"], state),
                                k=node.get("top_k", 3))
        text = "\n".join(f"[{i}]（{h['filename']}）{h['content']}" for i, h in enumerate(hits, start=1))
        refs = [{k: h[k] for k in ("document_id", "filename", "chunk_index", "score")} for h in hits]
        provenance = {**state.get(_PROVENANCE, {}), node["output"]: {"source": "vector", "refs": refs}}
        return {node["output"]: text, _PROVENANCE: provenance}, None

    def _wiki(self, node, state):
        from app.llm import wiki
        page = wiki.fetch_page(self.session, self.services, project_id=self.run.project_id, page_id=node["page_id"])
        provenance = {**state.get(_PROVENANCE, {}),
                      node["output"]: {"source": "wiki_api", "refs": [wiki.page_ref(page)]}}
        return {node["output"]: page.content, _PROVENANCE: provenance}, None

    def _llm(self, node, state):
        system = [render(node["system"], state) if node.get("system") else self.system_prompt]
        source, refs = "none", []
        if node.get("context"):
            origin = state.get(_PROVENANCE, {}).get(node["context"], {})
            source, refs = origin.get("source", "none"), origin.get("refs", [])
            system.append("Context:\n" + str(state.get(node["context"], "")))
        system_text = "\n\n".join(s for s in system if s and s.strip())
        messages = ([{"role": "system", "content": system_text}] if system_text else []) + [
            {"role": "user", "content": render(node["prompt"], state)}]
        call, result = call_llm(self.session, self.services, project_id=self.run.project_id,
                                username=self.run.username, origin="workflow", origin_ref=self._ref(node),
                                model=node.get("model") or self.model, messages=messages, params=self.params,
                                context_source=source, context_refs=refs)
        return {node["output"]: result.content}, call.id


def _decide(node: dict):
    def route(graph_state: GraphState) -> str:
        value = str((graph_state.get("values") or {}).get(node["key"], ""))
        if node["operator"] == "contains":
            matched = node["value"] in value
        elif node["operator"] == "equals":
            matched = value.strip() == node["value"].strip()
        else:
            matched = bool(value.strip())
        return node["then"] if matched else node["else"]
    return route


def build_graph(definition: dict, runner: _Runner):
    graph = StateGraph(GraphState)
    for node in definition["nodes"]:
        graph.add_node(node["id"], runner.wrap(node))
    graph.add_edge(START, definition["entry"])
    for source, target in definition["edges"]:
        graph.add_edge(source, END if target == END_NAME else target)
    for node in definition["nodes"]:
        if node["type"] == "condition":
            targets = {t: (END if t == END_NAME else t) for t in (node["then"], node["else"])}
            graph.add_conditional_edges(node["id"], _decide(node), targets)
    return graph.compile(checkpointer=MemorySaver())


def workflow_out(w: Workflow) -> dict:
    return {"id": w.id, "project_id": w.project_id, "name": w.name, "description": w.description,
            "definition": w.definition, "created_by": w.created_by, "created_at": iso(w.created_at),
            "updated_at": iso(w.updated_at)}


def get_workflow(session: Session, *, project_id: int, workflow_id: int) -> Workflow:
    workflow = session.get(Workflow, workflow_id)
    if workflow is None or workflow.project_id != project_id:
        raise NotFound(f"找不到工作流 {workflow_id}")
    return workflow


def list_workflows(session: Session, *, project_id: int) -> list[Workflow]:
    return list(session.scalars(select(Workflow).where(Workflow.project_id == project_id).order_by(Workflow.id)))


def create_workflow(session: Session, *, project_id: int, actor: str, source_ip: str | None, name: str,
                    description: str, definition: dict) -> Workflow:
    name = name.strip()
    if session.scalar(select(Workflow).where(Workflow.project_id == project_id, Workflow.name == name)):
        raise Conflict(f"專案內已有工作流「{name}」")
    workflow = Workflow(project_id=project_id, name=name, description=description, created_by=actor,
                        definition=validate(session, project_id=project_id, definition=definition))
    session.add(workflow)
    session.flush()
    record(session, actor=actor, category=AuditCategory.PROJECT, action="llm.workflow.create",
           target=f"workflow:{workflow.id}", source_ip=source_ip,
           detail={"name": name, "nodes": [n["id"] for n in workflow.definition["nodes"]]})
    session.commit()
    return workflow


def update_workflow(session: Session, *, project_id: int, actor: str, source_ip: str | None, workflow_id: int,
                    name: str, description: str, definition: dict) -> Workflow:
    workflow = get_workflow(session, project_id=project_id, workflow_id=workflow_id)
    name = name.strip()
    clash = session.scalar(select(Workflow).where(Workflow.project_id == project_id, Workflow.name == name,
                                                  Workflow.id != workflow.id))
    if clash:
        raise Conflict(f"專案內已有工作流「{name}」")
    workflow.definition = validate(session, project_id=project_id, definition=definition)
    workflow.name, workflow.description, workflow.updated_at = name, description, utcnow()
    record(session, actor=actor, category=AuditCategory.PROJECT, action="llm.workflow.update",
           target=f"workflow:{workflow.id}", source_ip=source_ip,
           detail={"nodes": [n["id"] for n in workflow.definition["nodes"]]})
    session.commit()
    return workflow


def delete_workflow(session: Session, *, project_id: int, actor: str, source_ip: str | None,
                    workflow_id: int) -> None:
    workflow = get_workflow(session, project_id=project_id, workflow_id=workflow_id)
    # 執行紀錄保留（稽核用），只刪定義
    session.delete(workflow)
    record(session, actor=actor, category=AuditCategory.PROJECT, action="llm.workflow.delete",
           target=f"workflow:{workflow_id}", source_ip=source_ip, detail={"name": workflow.name})
    session.commit()


def get_run(session: Session, *, project_id: int, workflow_id: int, run_id: int) -> WorkflowRun:
    run = session.get(WorkflowRun, run_id)
    if run is None or run.project_id != project_id or run.workflow_id != workflow_id:
        raise NotFound(f"找不到執行紀錄 {run_id}")
    return run


def list_runs(session: Session, *, project_id: int, workflow_id: int) -> list[WorkflowRun]:
    return list(session.scalars(select(WorkflowRun).where(
        WorkflowRun.project_id == project_id, WorkflowRun.workflow_id == workflow_id).order_by(WorkflowRun.id)))


def run_out(session: Session, run: WorkflowRun, *, detail: bool = True) -> dict:
    out = {"id": run.id, "workflow_id": run.workflow_id, "project_id": run.project_id, "user": run.username,
           "status": run.status, "input": run.input, "final_state": run.final_state, "error": run.error,
           "started_at": iso(run.started_at),
           "finished_at": iso(run.finished_at)}
    if detail:
        records = list(session.scalars(select(WorkflowNodeRecord).where(WorkflowNodeRecord.run_id == run.id)
                                       .order_by(WorkflowNodeRecord.seq)))
        calls = {c.id: c for c in session.scalars(select(LlmCallRecord).where(
            LlmCallRecord.id.in_([r.call_id for r in records if r.call_id])))} if records else {}
        out["nodes"] = [{
            "seq": r.seq, "node": r.node, "type": r.type, "status": r.status, "state_in": r.state_in,
            "state_out": r.state_out, "error": r.error, "call_id": r.call_id,
            "llm_request": calls[r.call_id].request if r.call_id in calls else None,
            "llm_response": calls[r.call_id].response if r.call_id in calls else None,
            "context_source": calls[r.call_id].context_source if r.call_id in calls else None,
            "started_at": iso(r.started_at),
            "finished_at": iso(r.finished_at)} for r in records]
    return out


def run_workflow(session: Session, services: LlmServices, *, project_id: int, actor: str, source_ip: str | None,
                 workflow_id: int, input: dict, continue_from: int | None = None) -> WorkflowRun:
    workflow = get_workflow(session, project_id=project_id, workflow_id=workflow_id)
    definition = workflow.definition
    unknown = [k for k in input if k not in definition["state"]]
    if unknown:
        raise Invalid(f"input 含有 state 沒有定義的欄位：{'、'.join(sorted(unknown))}")
    initial = dict(definition["state"])
    if continue_from is not None:
        previous = get_run(session, project_id=project_id, workflow_id=workflow_id, run_id=continue_from)
        if previous.status != "succeeded":
            raise Conflict("只能接續已成功完成的執行")
        initial.update(previous.final_state or {})
    initial.update(input)

    params = prompts.get_generation_params(session, project_id=project_id, username=actor)
    run = WorkflowRun(workflow_id=workflow.id, project_id=project_id, username=actor, status="running",
                      definition=definition, input=input)
    session.add(run)
    session.flush()
    runner = _Runner(session, services, run=run, model=choose_model(session, services, None),
                     params=to_openai(params), system_prompt=params.system_prompt)
    graph = build_graph(definition, runner)
    config = {"configurable": {"thread_id": f"run-{run.id}"}, "recursion_limit": MAX_STEPS}
    try:
        final = graph.invoke({"values": initial}, config)
        run.status, run.final_state = "succeeded", _public(final["values"])
    except _NodeFailed as exc:
        run.status, run.error = "failed", f"節點 {exc.node} 失敗：{exc}"[:512]
    except GraphRecursionError:
        run.status, run.error = "failed", f"超過步數上限（{MAX_STEPS}），請檢查條件節點是否形成無窮迴圈"
    run.finished_at = utcnow()
    session.add(run)
    record(session, actor=actor, category=AuditCategory.INFERENCE, action="llm.workflow.run",
           target=f"workflow:{workflow.id}", result="success" if run.status == "succeeded" else "failed",
           source_ip=source_ip, detail={"run_id": run.id, "nodes_executed": runner.seq, "error": run.error})
    session.commit()
    return run
