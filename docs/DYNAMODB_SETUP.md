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
  "pk": "hash_of_user_id",
  "sk": "random_64_char_hex",
  "sessionToken": "hash_of_user_id:random_64_char_hex",
  "csrfToken": "random_64_char_hex",
  "sessionKey": "user_123",
  "data": {
    "userId": "user_123",
    "username": "john_doe",
    "role": "admin"
  },
  "createdAt": 1697712000,
  "lastAccessedAt": 1697712300,
  "expiresAt": 1700304000,
  "ttlInSeconds": 2592000
}
```