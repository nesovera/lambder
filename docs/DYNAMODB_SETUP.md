# DynamoDB Session Table Setup Guide

This guide helps you set up a DynamoDB table for Lambder session management with all security features enabled.

## Table Creation

### Using Terraform

```hcl
resource "aws_dynamodb_table" "lambder_sessions" {
  name           = "lambder-sessions"
  billing_mode   = "PAY_PER_REQUEST"
  hash_key       = "pk"
  range_key      = "sk"

  attribute {
    name = "pk"
    type = "S"
  }

  attribute {
    name = "sk"
    type = "S"
  }

  ttl {
    enabled        = true
    attribute_name = "expiresAt"
  }

  tags = {
    Purpose = "Session Management"
  }
}
```

## Enable Time to Live (TTL)

TTL automatically removes expired sessions from DynamoDB, saving storage costs.

### Using AWS Console

1. Go to DynamoDB Console
2. Select your table (`lambder-sessions`)
3. Navigate to **Additional settings** tab
4. Click **Edit** under **Time to Live (TTL)**
5. Enable TTL
6. Set **TTL attribute** to: `expiresAt`
7. Save changes

## IAM Permissions

Your Lambda function needs these permissions:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "dynamodb:GetItem",
        "dynamodb:PutItem",
        "dynamodb:DeleteItem",
        "dynamodb:Query"
      ],
      "Resource": [
        "arn:aws:dynamodb:us-east-1:123456789012:table/lambder-sessions"
      ]
    }
  ]
}
```

## Session Data Structure

Each session is stored as:

```json
{
  "pk": "sha256(sessionKey + sessionSalt)",
  "sk": "sha256(cookie secret)",
  "csrfTokenHash": "sha256(csrf token)",
  "sessionKey": "user_123",
  "dataBr": "<binary: Brotli of the data JSON>",
  "dataBytes": 61,
  "createdAt": 1697712000,
  "lastAccessedAt": 1697712300,
  "expiresAt": 1700304000,
  "ttlInSeconds": 2592000
}
```

The bearer secrets are stored only as hashes (see "How the secrets are stored" in the Readme). Session data is Brotli-compressed by default, `dataBr` beside its JSON byte length `dataBytes`; with `session.compression` off, or below its `minBytes`, the data is a plain `data` map attribute instead. Records written under either setting read back, so the setting can be switched on or off on a live table. Sessions configured with `dataRefresh` also carry `dataExpiresAt`.