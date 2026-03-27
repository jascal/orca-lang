# Orca Workflows for Agent Framework Demo

This file defines the state machines used throughout the demo-python package.

## OrderProcessor

Handles order lifecycle from placement through delivery.

```orca
machine OrderProcessor

context {
    order_id: ""
    customer_id: ""
    total: 0
    status: "pending"
    items: []
}

state pending [initial] "Order received, awaiting validation"
  on ORDER_PLACED -> validating

state validating "Validating order details"
  on VALIDATED -> payment_pending
  on REJECTED -> rejected

state payment_pending "Awaiting payment"
  on PAYMENT_INITIATED -> processing
  on PAYMENT_FAILED -> payment_failed

state processing "Processing order"
  on PROCESSED -> fulfilled

state fulfilled "Order ready for shipping"
  on SHIPPED -> shipped

state shipped "Order shipped"
  on DELIVERED -> delivered

state delivered [final] "Order completed"

state rejected [final] "Order rejected"

state payment_failed "Payment failed, awaiting retry"
  on RETRY_PAYMENT -> payment_pending
  on CANCEL -> rejected
```

## AgentSupervisor

Manages task assignment and subtask completion for multi-agent orchestration.

```orca
machine AgentSupervisor

context {
    task_id: ""
    agent_id: ""
    status: "idle"
    result: ""
    subtasks: []
    completed_subtasks: []
}

state idle [initial] "Agent ready for tasks"
  on TASK_ASSIGNED -> working

state working "Agent processing task"
  on SUBTASK_CREATED -> working
  on SUBTASK_COMPLETED -> working
  on ALL_SUBTASKS_COMPLETE -> success
  on TASK_FAILED -> failed

state success [final] "Task completed successfully"

state failed [final] "Task failed"
```

## PaymentProcessor

Simple payment flow with success and failure states.

```orca
machine PaymentProcessor

context { amount: 0 }

state pending [initial] "Payment pending"
  on PROCESS -> processing

state processing "Processing payment"
  on SUCCESS -> completed
  on FAILURE -> failed

state completed [final] "Payment successful"

state failed [final] "Payment failed"
```
