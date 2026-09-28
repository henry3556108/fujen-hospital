from enum import StrEnum


class Permission(StrEnum):
    PROJECT = "project"
    TRAINING = "training"
    LABELING = "labeling"
    CODING = "coding"
    PREDICTION = "prediction"


class Role(StrEnum):
    VIEWER = "viewer"
    CODER_ASSISTANT = "coder_assistant"
    RESEARCH_ASSISTANT = "research_assistant"
    MEDICAL_DOCTOR = "medical_doctor"
    PRINCIPAL_INVESTIGATOR = "principal_investigator"


class AccountType(StrEnum):
    ADMIN = "admin"
    USER = "user"


_P = Permission

# 角色預設權限，需與甲方確認；加入專案時套用，之後可逐人調整。
DEFAULT_ROLE_PERMISSIONS: dict[Role, frozenset[Permission]] = {
    Role.VIEWER: frozenset({_P.PROJECT, _P.PREDICTION}),
    Role.MEDICAL_DOCTOR: frozenset({_P.PROJECT, _P.LABELING, _P.PREDICTION}),
    Role.RESEARCH_ASSISTANT: frozenset({_P.PROJECT, _P.LABELING, _P.TRAINING, _P.PREDICTION}),
    Role.CODER_ASSISTANT: frozenset({_P.PROJECT, _P.TRAINING, _P.CODING, _P.PREDICTION}),
    Role.PRINCIPAL_INVESTIGATOR: frozenset(_P),
}
