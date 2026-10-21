-- Match the shared Intl.Collator('en', { numeric: true, sensitivity: 'base' }).
CREATE COLLATION honghao_code_natural (provider = icu, locale = 'en-u-kn-true-ks-level1', deterministic = false);
