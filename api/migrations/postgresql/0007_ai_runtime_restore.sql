-- Preserve the message/run back-reference without requiring cyclic COPY order.
-- Validation still happens before the surrounding transaction can commit.
ALTER TABLE conversation_messages
    ALTER CONSTRAINT conversation_messages_run_id_owner_id_conversation_id_fkey
    DEFERRABLE INITIALLY DEFERRED;
