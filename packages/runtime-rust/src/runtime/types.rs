use serde_json::Value;
use std::collections::HashMap;

/// Top-level machine definition parsed from .orca.md
#[derive(Debug, Clone)]
pub struct MachineDef {
    pub name: String,
    pub context: Value,
    pub events: Vec<String>,
    pub states: Vec<StateDef>,
    pub transitions: Vec<Transition>,
    pub guards: HashMap<String, GuardExpression>,
    pub actions: Vec<ActionSignature>,
}

/// A single flat state
#[derive(Debug, Clone)]
pub struct StateDef {
    pub name: String,
    pub is_initial: bool,
    pub is_final: bool,
    pub description: Option<String>,
    pub on_entry: Option<String>,
    pub on_exit: Option<String>,
}

/// A transition between states
#[derive(Debug, Clone)]
pub struct Transition {
    pub source: String,
    pub event: String,
    pub guard: Option<String>,
    pub target: String,
    pub action: Option<String>,
}

/// Action signature from ## actions table
#[derive(Debug, Clone)]
pub struct ActionSignature {
    pub name: String,
    pub signature: String,
}

/// Guard expression AST
#[derive(Debug, Clone, PartialEq)]
pub enum GuardExpression {
    True,
    False,
    Not(Box<GuardExpression>),
    And(Box<GuardExpression>, Box<GuardExpression>),
    Or(Box<GuardExpression>, Box<GuardExpression>),
    Compare {
        op: CompareOp,
        left: VariableRef,
        right: ValueRef,
    },
    Nullcheck {
        expr: VariableRef,
        is_null: bool,
    },
}

/// Comparison operator
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CompareOp {
    Eq,
    Ne,
    Lt,
    Gt,
    Le,
    Ge,
}

/// Reference to a context variable (e.g., ctx.price -> path = ["price"])
#[derive(Debug, Clone, PartialEq)]
pub struct VariableRef {
    pub path: Vec<String>,
}

/// A literal value in a guard expression
#[derive(Debug, Clone, PartialEq)]
pub enum ValueRef {
    Str(String),
    Number(f64),
    Integer(i64),
    Boolean(bool),
    Null,
}

/// Errors from parsing
#[derive(Debug, Clone)]
pub struct ParseError {
    pub message: String,
}

impl std::fmt::Display for ParseError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Parse error: {}", self.message)
    }
}

impl std::error::Error for ParseError {}

/// Errors from verification
#[derive(Debug, Clone)]
pub struct VerifyError {
    pub message: String,
    pub code: VerifyCode,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VerifyCode {
    NoInitialState,
    MultipleInitialStates,
    InvalidTransitionSource,
    InvalidTransitionTarget,
    UnreachableState,
    Deadlock,
}

/// Warnings from verification (non-fatal)
#[derive(Debug, Clone)]
pub struct VerifyWarning {
    pub message: String,
    pub code: VerifyCode,
}

/// Runtime errors
#[derive(Debug, Clone)]
pub struct OrcaError {
    pub message: String,
}

impl std::fmt::Display for OrcaError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Orca error: {}", self.message)
    }
}

impl std::error::Error for OrcaError {}
