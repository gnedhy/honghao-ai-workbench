CREATE TABLE honghao_meta.database_identity (
    singleton boolean PRIMARY KEY CHECK (singleton),
    environment text NOT NULL CHECK (
        environment IN ('development', 'test', 'acceptance', 'production')
    )
);
