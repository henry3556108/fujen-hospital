"""WP7：LLM、RAG、工作流、Wiki 與模型白名單。對外只匯出 router。"""
import os

# LangGraph／LangChain 的遙測一律關閉：平台不對外連線
os.environ.setdefault("LANGSMITH_TRACING", "false")
os.environ.setdefault("LANGCHAIN_TRACING_V2", "false")
