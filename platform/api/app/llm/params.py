"""7 項生成參數（B-07）：Temperature、Max New Tokens、Repetition Penalty、Length Penalty、Top K、Top P、System Prompt。"""
from pydantic import BaseModel, ConfigDict, Field


class GenerationParams(BaseModel):
    model_config = ConfigDict(extra="forbid")
    temperature: float = Field(default=0.7, ge=0.0, le=2.0)
    max_new_tokens: int = Field(default=512, ge=1, le=8192)
    repetition_penalty: float = Field(default=1.0, ge=0.1, le=2.0)
    length_penalty: float = Field(default=1.0, ge=-2.0, le=2.0)
    top_k: int = Field(default=50, ge=1, le=1000)
    top_p: float = Field(default=0.9, gt=0.0, le=1.0)
    system_prompt: str = Field(default="", max_length=8000)


PARAM_NAMES = tuple(GenerationParams.model_fields)


def to_openai(params: GenerationParams) -> dict:
    """轉成 OpenAI 相容 API 的取樣欄位。repetition_penalty、length_penalty、top_k 是 vLLM 的擴充欄位；
    system_prompt 不在這裡，由呼叫端放進 messages。"""
    return {
        "temperature": params.temperature,
        "max_tokens": params.max_new_tokens,
        "repetition_penalty": params.repetition_penalty,
        "length_penalty": params.length_penalty,
        "top_k": params.top_k,
        "top_p": params.top_p,
    }
