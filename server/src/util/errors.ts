/** Platform errors carrying Salesforce-style error codes and HTTP status. */
export class SfError extends Error {
  errorCode: string;
  status: number;
  fields: string[];

  constructor(errorCode: string, message: string, status = 400, fields: string[] = []) {
    super(message);
    this.errorCode = errorCode;
    this.status = status;
    this.fields = fields;
  }

  toBody() {
    return [{ message: this.message, errorCode: this.errorCode, fields: this.fields }];
  }
}

export const Errors = {
  invalidSession: () => new SfError('INVALID_SESSION_ID', 'Session expired or invalid', 401),
  invalidLogin: () => new SfError('INVALID_LOGIN', 'Invalid username, password, or user locked out.', 401),
  notFound: (msg = 'The requested resource does not exist') => new SfError('NOT_FOUND', msg, 404),
  invalidType: (type: string) =>
    new SfError('INVALID_TYPE', `sObject type '${type}' is not supported.`, 404),
  invalidField: (field: string, object?: string) =>
    new SfError(
      'INVALID_FIELD',
      `No such column '${field}' on ${object ? `entity '${object}'` : 'the entity'}.`,
      400
    ),
  malformedQuery: (msg: string) => new SfError('MALFORMED_QUERY', msg, 400),
  malformedSearch: (msg: string) => new SfError('MALFORMED_SEARCH', msg, 400),
  requiredField: (fields: string[]) =>
    new SfError(
      'REQUIRED_FIELD_MISSING',
      `Required fields are missing: [${fields.join(', ')}]`,
      400,
      fields
    ),
  validation: (message: string, fields: string[] = []) =>
    new SfError('FIELD_CUSTOM_VALIDATION_EXCEPTION', message, 400, fields),
  insufficientAccess: (msg = 'insufficient access rights on object') =>
    new SfError('INSUFFICIENT_ACCESS_OR_READONLY', msg, 403),
  crossOrg: () => new SfError('INVALID_CROSS_REFERENCE_KEY', 'invalid cross reference id', 400),
  duplicateValue: (msg: string) => new SfError('DUPLICATE_VALUE', msg, 400),
  limitExceeded: (what: string) =>
    new SfError('LIMIT_EXCEEDED', `TotalRequests Limit exceeded: ${what}`, 403),
  invalidGrant: (msg = 'authentication failure') => new SfError('invalid_grant', msg, 400),
  entityLocked: () =>
    new SfError('ENTITY_IS_LOCKED', 'This record is locked by an approval process.', 403),
  invalidOperation: (msg: string) => new SfError('INVALID_OPERATION', msg, 400),
  jsonParse: (msg: string) => new SfError('JSON_PARSER_ERROR', msg, 400),
  stringTooLong: (field: string, max: number) =>
    new SfError('STRING_TOO_LONG', `${field}: data value too large (max length=${max})`, 400, [field]),
  badPicklist: (field: string, value: string) =>
    new SfError('INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST', `${field}: bad value for restricted picklist field: ${value}`, 400, [field])
};
