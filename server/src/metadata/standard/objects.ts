/**
 * Standard-object catalog: the Salesforce core data model expressed as installer
 * specs. Installed into every new org at provisioning time. Club-domain custom
 * objects live in the seed (they are ordinary customer metadata, not platform).
 */
import type { ObjectSpec, FieldSpec } from '../installer.js';

const INDUSTRY = {
  values: [
    'Agriculture', 'Apparel', 'Banking', 'Biotechnology', 'Chemicals', 'Communications',
    'Construction', 'Consulting', 'Education', 'Electronics', 'Energy', 'Engineering',
    'Entertainment', 'Environmental', 'Finance', 'Food & Beverage', 'Government', 'Healthcare',
    'Hospitality', 'Insurance', 'Machinery', 'Manufacturing', 'Media', 'Not For Profit',
    'Recreation', 'Retail', 'Shipping', 'Technology', 'Telecommunications', 'Transportation',
    'Utilities', 'Other'
  ]
};

const LEAD_SOURCE = {
  values: ['Web', 'Phone Inquiry', 'Partner Referral', 'Member Referral', 'Purchased List', 'Event', 'Walk-In', 'Other']
};

const SALUTATION = { values: ['Mr.', 'Ms.', 'Mrs.', 'Dr.', 'Prof.'] };

const address = (prefix: string): FieldSpec[] => [
  { apiName: `${prefix}Street`, label: `${prefix} Street`, type: 'TextArea' },
  { apiName: `${prefix}City`, label: `${prefix} City`, type: 'Text', length: 40 },
  { apiName: `${prefix}State`, label: `${prefix} State/Province`, type: 'Text', length: 80 },
  { apiName: `${prefix}PostalCode`, label: `${prefix} Zip/Postal Code`, type: 'Text', length: 20 },
  { apiName: `${prefix}Country`, label: `${prefix} Country`, type: 'Text', length: 80 }
];

export const ACCOUNT: ObjectSpec = {
  apiName: 'Account',
  label: 'Account',
  pluralLabel: 'Accounts',
  icon: 'account',
  color: '#7F8DE1',
  sharingModel: 'ReadWrite',
  fields: [
    { apiName: 'Type', label: 'Account Type', type: 'Picklist', picklist: { values: ['Prospect', 'Customer - Direct', 'Customer - Channel', 'Channel Partner / Reseller', 'Installation Partner', 'Technology Partner', 'Other'] } },
    { apiName: 'ParentId', label: 'Parent Account', type: 'Lookup', referenceTo: 'Account', relationshipName: 'ChildAccounts' },
    { apiName: 'AccountNumber', label: 'Account Number', type: 'Text', length: 40 },
    { apiName: 'Industry', label: 'Industry', type: 'Picklist', picklist: INDUSTRY },
    { apiName: 'AnnualRevenue', label: 'Annual Revenue', type: 'Currency', precision: 18, scale: 0 },
    { apiName: 'Rating', label: 'Account Rating', type: 'Picklist', picklist: { values: ['Hot', 'Warm', 'Cold'] } },
    { apiName: 'Phone', label: 'Account Phone', type: 'Phone' },
    { apiName: 'Fax', label: 'Account Fax', type: 'Phone' },
    { apiName: 'Website', label: 'Website', type: 'Url' },
    { apiName: 'NumberOfEmployees', label: 'Employees', type: 'Number', precision: 8, scale: 0 },
    { apiName: 'Ownership', label: 'Ownership', type: 'Picklist', picklist: { values: ['Public', 'Private', 'Subsidiary', 'Other'] } },
    { apiName: 'TickerSymbol', label: 'Ticker Symbol', type: 'Text', length: 20 },
    { apiName: 'Site', label: 'Account Site', type: 'Text', length: 80 },
    ...address('Billing'),
    ...address('Shipping'),
    { apiName: 'Description', label: 'Account Description', type: 'LongTextArea', trackHistory: false }
  ],
  layoutSections: [
    { label: 'Account Information', columns: 2, fields: ['Name', 'OwnerId', 'ParentId', 'AccountNumber', 'Type', 'Industry', 'Rating', 'Phone', 'Fax', 'Website', 'TickerSymbol', 'Ownership', 'NumberOfEmployees', 'AnnualRevenue', 'Site'] },
    { label: 'Address Information', columns: 2, fields: ['BillingStreet', 'ShippingStreet', 'BillingCity', 'ShippingCity', 'BillingState', 'ShippingState', 'BillingPostalCode', 'ShippingPostalCode', 'BillingCountry', 'ShippingCountry'] },
    { label: 'Description Information', columns: 1, fields: ['Description'] },
    { label: 'System Information', columns: 2, fields: ['CreatedById', 'LastModifiedById'] }
  ],
  highlights: ['Name', 'Type', 'Phone', 'Website', 'OwnerId'],
  listViews: [
    { apiName: 'All', label: 'All Accounts', columns: ['Name', 'Type', 'BillingCity', 'Phone', 'OwnerId'] },
    { apiName: 'My', label: 'My Accounts', columns: ['Name', 'Type', 'BillingCity', 'Phone'], scope: 'mine' }
  ]
};

export const CONTACT: ObjectSpec = {
  apiName: 'Contact',
  label: 'Contact',
  pluralLabel: 'Contacts',
  icon: 'contact',
  color: '#A094ED',
  fields: [
    { apiName: 'Salutation', label: 'Salutation', type: 'Picklist', picklist: SALUTATION },
    { apiName: 'FirstName', label: 'First Name', type: 'Text', length: 40 },
    { apiName: 'LastName', label: 'Last Name', type: 'Text', length: 80, required: true },
    { apiName: 'AccountId', label: 'Account Name', type: 'Lookup', referenceTo: 'Account', relationshipName: 'Contacts' },
    { apiName: 'Title', label: 'Title', type: 'Text', length: 128 },
    { apiName: 'Department', label: 'Department', type: 'Text', length: 80 },
    { apiName: 'Email', label: 'Email', type: 'Email' },
    { apiName: 'Phone', label: 'Business Phone', type: 'Phone' },
    { apiName: 'MobilePhone', label: 'Mobile Phone', type: 'Phone' },
    { apiName: 'HomePhone', label: 'Home Phone', type: 'Phone' },
    { apiName: 'Birthdate', label: 'Birthdate', type: 'Date' },
    { apiName: 'LeadSource', label: 'Lead Source', type: 'Picklist', picklist: LEAD_SOURCE },
    { apiName: 'ReportsToId', label: 'Reports To', type: 'Lookup', referenceTo: 'Contact', relationshipName: 'DirectReports' },
    { apiName: 'AssistantName', label: "Assistant's Name", type: 'Text', length: 40 },
    { apiName: 'AssistantPhone', label: 'Asst. Phone', type: 'Phone' },
    { apiName: 'DoNotCall', label: 'Do Not Call', type: 'Checkbox' },
    { apiName: 'HasOptedOutOfEmail', label: 'Email Opt Out', type: 'Checkbox' },
    ...address('Mailing'),
    { apiName: 'Description', label: 'Contact Description', type: 'LongTextArea' }
  ],
  layoutSections: [
    { label: 'Contact Information', columns: 2, fields: ['Salutation', 'OwnerId', 'FirstName', 'Phone', 'LastName', 'MobilePhone', 'AccountId', 'HomePhone', 'Title', 'Email', 'Department', 'LeadSource', 'Birthdate', 'ReportsToId', 'DoNotCall', 'HasOptedOutOfEmail'] },
    { label: 'Address Information', columns: 2, fields: ['MailingStreet', 'MailingCity', 'MailingState', 'MailingPostalCode', 'MailingCountry'] },
    { label: 'Additional Information', columns: 2, fields: ['AssistantName', 'AssistantPhone'] },
    { label: 'Description Information', columns: 1, fields: ['Description'] },
    { label: 'System Information', columns: 2, fields: ['CreatedById', 'LastModifiedById'] }
  ],
  highlights: ['Name', 'Title', 'AccountId', 'Phone', 'Email'],
  listViews: [
    { apiName: 'All', label: 'All Contacts', columns: ['Name', 'AccountId', 'Title', 'Email', 'Phone'] },
    { apiName: 'My', label: 'My Contacts', columns: ['Name', 'AccountId', 'Title', 'Email', 'Phone'], scope: 'mine' },
    { apiName: 'Birthdays', label: 'Birthdays This Month', columns: ['Name', 'Birthdate', 'Email', 'Phone'], filters: [{ field: 'Birthdate', op: 'thisMonth', value: null }] }
  ]
};

export const LEAD: ObjectSpec = {
  apiName: 'Lead',
  label: 'Lead',
  pluralLabel: 'Leads',
  icon: 'lead',
  color: '#F88962',
  sharingModel: 'ReadWrite',
  fields: [
    { apiName: 'Salutation', label: 'Salutation', type: 'Picklist', picklist: SALUTATION },
    { apiName: 'FirstName', label: 'First Name', type: 'Text', length: 40 },
    { apiName: 'LastName', label: 'Last Name', type: 'Text', length: 80, required: true },
    { apiName: 'Company', label: 'Company', type: 'Text', length: 255, required: true },
    { apiName: 'Title', label: 'Title', type: 'Text', length: 128 },
    { apiName: 'Email', label: 'Email', type: 'Email' },
    { apiName: 'Phone', label: 'Phone', type: 'Phone' },
    { apiName: 'MobilePhone', label: 'Mobile Phone', type: 'Phone' },
    { apiName: 'Website', label: 'Website', type: 'Url' },
    {
      apiName: 'Status', label: 'Lead Status', type: 'Picklist', required: true,
      picklist: {
        values: [
          { value: 'Open - Not Contacted', default: true },
          { value: 'Working - Contacted' },
          { value: 'Closed - Converted', meta: { converted: true, closed: true } },
          { value: 'Closed - Not Converted', meta: { closed: true } }
        ]
      }
    },
    { apiName: 'LeadSource', label: 'Lead Source', type: 'Picklist', picklist: LEAD_SOURCE },
    { apiName: 'Industry', label: 'Industry', type: 'Picklist', picklist: INDUSTRY },
    { apiName: 'Rating', label: 'Rating', type: 'Picklist', picklist: { values: ['Hot', 'Warm', 'Cold'] } },
    { apiName: 'AnnualRevenue', label: 'Annual Revenue', type: 'Currency', precision: 18, scale: 0 },
    { apiName: 'NumberOfEmployees', label: 'No. of Employees', type: 'Number', precision: 8, scale: 0 },
    ...address(''),
    { apiName: 'Description', label: 'Description', type: 'LongTextArea' },
    { apiName: 'IsConverted', label: 'Converted', type: 'Checkbox' },
    { apiName: 'ConvertedDate', label: 'Converted Date', type: 'Date' },
    { apiName: 'ConvertedAccountId', label: 'Converted Account', type: 'Lookup', referenceTo: 'Account', relationshipName: 'ConvertedLeads' },
    { apiName: 'ConvertedContactId', label: 'Converted Contact', type: 'Lookup', referenceTo: 'Contact', relationshipName: 'ConvertedLeads' },
    { apiName: 'ConvertedOpportunityId', label: 'Converted Opportunity', type: 'Lookup', referenceTo: 'Opportunity', relationshipName: 'ConvertedLeads' },
    { apiName: 'IsUnreadByOwner', label: 'Unread By Owner', type: 'Checkbox' },
    { apiName: 'DoNotCall', label: 'Do Not Call', type: 'Checkbox' },
    { apiName: 'HasOptedOutOfEmail', label: 'Email Opt Out', type: 'Checkbox' }
  ],
  layoutSections: [
    { label: 'Lead Information', columns: 2, fields: ['OwnerId', 'Phone', 'Salutation', 'MobilePhone', 'FirstName', 'Email', 'LastName', 'Website', 'Company', 'Status', 'Title', 'Rating', 'LeadSource', 'Industry', 'AnnualRevenue', 'NumberOfEmployees'] },
    { label: 'Address Information', columns: 2, fields: ['Street', 'City', 'State', 'PostalCode', 'Country'] },
    { label: 'Description Information', columns: 1, fields: ['Description'] },
    { label: 'System Information', columns: 2, fields: ['CreatedById', 'LastModifiedById', 'IsConverted', 'ConvertedDate'] }
  ],
  highlights: ['Name', 'Company', 'Status', 'Phone', 'Email'],
  listViews: [
    { apiName: 'All', label: 'All Leads', columns: ['Name', 'Company', 'Status', 'LeadSource', 'Email', 'Phone', 'OwnerId'] },
    { apiName: 'My', label: 'My Leads', columns: ['Name', 'Company', 'Status', 'LeadSource', 'Email'], scope: 'mine' },
    { apiName: 'Open', label: 'Open Leads', columns: ['Name', 'Company', 'Status', 'CreatedDate', 'OwnerId'], filters: [{ field: 'IsConverted', op: 'equals', value: false }], kanban: { groupField: 'Status' } }
  ]
};

export const OPPORTUNITY: ObjectSpec = {
  apiName: 'Opportunity',
  label: 'Opportunity',
  pluralLabel: 'Opportunities',
  icon: 'opportunity',
  color: '#FCB95B',
  fields: [
    { apiName: 'AccountId', label: 'Account Name', type: 'Lookup', referenceTo: 'Account', relationshipName: 'Opportunities' },
    {
      apiName: 'StageName', label: 'Stage', type: 'Picklist', required: true,
      picklist: {
        values: [
          { value: 'Prospecting', default: true, meta: { probability: 10, forecast: 'Pipeline' } },
          { value: 'Qualification', meta: { probability: 20, forecast: 'Pipeline' } },
          { value: 'Needs Analysis', meta: { probability: 30, forecast: 'Pipeline' } },
          { value: 'Value Proposition', meta: { probability: 40, forecast: 'Pipeline' } },
          { value: 'Id. Decision Makers', meta: { probability: 50, forecast: 'Pipeline' } },
          { value: 'Perception Analysis', meta: { probability: 60, forecast: 'Best Case' } },
          { value: 'Proposal/Price Quote', meta: { probability: 70, forecast: 'Best Case' } },
          { value: 'Negotiation/Review', meta: { probability: 80, forecast: 'Commit' } },
          { value: 'Closed Won', meta: { probability: 100, forecast: 'Closed', isClosed: true, isWon: true } },
          { value: 'Closed Lost', meta: { probability: 0, forecast: 'Omitted', isClosed: true } }
        ]
      }
    },
    { apiName: 'Amount', label: 'Amount', type: 'Currency', precision: 16, scale: 2 },
    { apiName: 'Probability', label: 'Probability (%)', type: 'Percent', precision: 3, scale: 0 },
    { apiName: 'CloseDate', label: 'Close Date', type: 'Date', required: true },
    { apiName: 'Type', label: 'Opportunity Type', type: 'Picklist', picklist: { values: ['Existing Business', 'New Business'] } },
    { apiName: 'NextStep', label: 'Next Step', type: 'Text', length: 255 },
    { apiName: 'LeadSource', label: 'Lead Source', type: 'Picklist', picklist: LEAD_SOURCE },
    { apiName: 'ForecastCategoryName', label: 'Forecast Category', type: 'Picklist', picklist: { values: ['Omitted', 'Pipeline', 'Best Case', 'Commit', 'Closed'] } },
    { apiName: 'IsClosed', label: 'Closed', type: 'Checkbox' },
    { apiName: 'IsWon', label: 'Won', type: 'Checkbox' },
    { apiName: 'CampaignId', label: 'Primary Campaign Source', type: 'Lookup', referenceTo: 'Campaign', relationshipName: 'Opportunities' },
    { apiName: 'Pricebook2Id', label: 'Price Book', type: 'Lookup', referenceTo: 'Pricebook2', relationshipName: 'Opportunities' },
    { apiName: 'ExpectedRevenue', label: 'Expected Amount', type: 'Formula', formula: 'Amount * Probability / 100', formulaReturnType: 'Currency' },
    { apiName: 'Description', label: 'Description', type: 'LongTextArea' }
  ],
  layoutSections: [
    { label: 'Opportunity Information', columns: 2, fields: ['Name', 'OwnerId', 'AccountId', 'CloseDate', 'StageName', 'Amount', 'Probability', 'ExpectedRevenue', 'Type', 'LeadSource', 'NextStep', 'ForecastCategoryName', 'CampaignId', 'Pricebook2Id'] },
    { label: 'Description Information', columns: 1, fields: ['Description'] },
    { label: 'System Information', columns: 2, fields: ['CreatedById', 'LastModifiedById', 'IsClosed', 'IsWon'] }
  ],
  highlights: ['Name', 'AccountId', 'StageName', 'Amount', 'CloseDate'],
  listViews: [
    { apiName: 'All', label: 'All Opportunities', columns: ['Name', 'AccountId', 'Amount', 'CloseDate', 'StageName', 'OwnerId'] },
    { apiName: 'My', label: 'My Opportunities', columns: ['Name', 'AccountId', 'Amount', 'CloseDate', 'StageName'], scope: 'mine' },
    {
      apiName: 'Pipeline', label: 'Open Pipeline', columns: ['Name', 'AccountId', 'Amount', 'CloseDate', 'StageName', 'Probability'],
      filters: [{ field: 'IsClosed', op: 'equals', value: false }],
      kanban: { groupField: 'StageName', sumField: 'Amount' }
    }
  ]
};

export const CASE: ObjectSpec = {
  apiName: 'Case',
  label: 'Case',
  pluralLabel: 'Cases',
  icon: 'case',
  color: '#F2CF5B',
  nameFieldApi: 'CaseNumber',
  nameFieldLabel: 'Case Number',
  nameFieldType: 'AutoNumber',
  autoNumberFormat: '{00001000}',
  fields: [
    { apiName: 'Subject', label: 'Subject', type: 'Text', length: 255 },
    { apiName: 'Description', label: 'Description', type: 'LongTextArea' },
    {
      apiName: 'Status', label: 'Status', type: 'Picklist', required: true,
      picklist: {
        values: [
          { value: 'New', default: true },
          { value: 'Working' },
          { value: 'Escalated' },
          { value: 'Closed', meta: { closed: true } }
        ]
      }
    },
    { apiName: 'Origin', label: 'Case Origin', type: 'Picklist', picklist: { values: ['Phone', 'Email', 'Web', 'In Person'] } },
    { apiName: 'Priority', label: 'Priority', type: 'Picklist', picklist: { values: ['High', { value: 'Medium', default: true }, 'Low'] } },
    { apiName: 'Reason', label: 'Case Reason', type: 'Picklist', picklist: { values: ['Billing', 'Facilities', 'Service Quality', 'Membership', 'Events', 'Feedback', 'Other'] } },
    { apiName: 'Type', label: 'Case Type', type: 'Picklist', picklist: { values: ['Question', 'Problem', 'Feature Request', 'Complaint'] } },
    { apiName: 'AccountId', label: 'Account Name', type: 'Lookup', referenceTo: 'Account', relationshipName: 'Cases' },
    { apiName: 'ContactId', label: 'Contact Name', type: 'Lookup', referenceTo: 'Contact', relationshipName: 'Cases' },
    { apiName: 'SuppliedName', label: 'Web Name', type: 'Text', length: 80 },
    { apiName: 'SuppliedEmail', label: 'Web Email', type: 'Email' },
    { apiName: 'SuppliedPhone', label: 'Web Phone', type: 'Phone' },
    { apiName: 'IsClosed', label: 'Closed', type: 'Checkbox' },
    { apiName: 'ClosedDate', label: 'Closed Date', type: 'DateTime' },
    { apiName: 'IsEscalated', label: 'Escalated', type: 'Checkbox' }
  ],
  layoutSections: [
    { label: 'Case Information', columns: 2, fields: ['CaseNumber', 'OwnerId', 'ContactId', 'Status', 'AccountId', 'Priority', 'Type', 'Origin', 'Reason', 'IsEscalated'] },
    { label: 'Description Information', columns: 1, fields: ['Subject', 'Description'] },
    { label: 'Web Information', columns: 2, fields: ['SuppliedName', 'SuppliedEmail', 'SuppliedPhone'] },
    { label: 'System Information', columns: 2, fields: ['CreatedById', 'LastModifiedById', 'IsClosed', 'ClosedDate'] }
  ],
  highlights: ['CaseNumber', 'ContactId', 'Status', 'Priority', 'Subject'],
  listViews: [
    { apiName: 'All', label: 'All Cases', columns: ['CaseNumber', 'ContactId', 'Subject', 'Status', 'Priority', 'CreatedDate'] },
    { apiName: 'My', label: 'My Open Cases', columns: ['CaseNumber', 'ContactId', 'Subject', 'Status', 'Priority'], scope: 'mine', filters: [{ field: 'IsClosed', op: 'equals', value: false }] },
    { apiName: 'Open', label: 'All Open Cases', columns: ['CaseNumber', 'ContactId', 'Subject', 'Status', 'Priority', 'OwnerId'], filters: [{ field: 'IsClosed', op: 'equals', value: false }], kanban: { groupField: 'Status' } }
  ]
};

export const CAMPAIGN: ObjectSpec = {
  apiName: 'Campaign',
  label: 'Campaign',
  pluralLabel: 'Campaigns',
  icon: 'campaign',
  color: '#F49756',
  fields: [
    { apiName: 'IsActive', label: 'Active', type: 'Checkbox' },
    { apiName: 'Type', label: 'Campaign Type', type: 'Picklist', picklist: { values: ['Members Event', 'Dinner', 'Talk / Salon', 'Conference', 'Webinar', 'Direct Mail', 'Email', 'Referral Program', 'Advertisement', 'Other'] } },
    { apiName: 'Status', label: 'Status', type: 'Picklist', picklist: { values: [{ value: 'Planned', default: true }, 'In Progress', 'Completed', 'Aborted'] } },
    { apiName: 'StartDate', label: 'Start Date', type: 'Date' },
    { apiName: 'EndDate', label: 'End Date', type: 'Date' },
    { apiName: 'ExpectedRevenue', label: 'Expected Revenue', type: 'Currency', precision: 18, scale: 2 },
    { apiName: 'BudgetedCost', label: 'Budgeted Cost', type: 'Currency', precision: 18, scale: 2 },
    { apiName: 'ActualCost', label: 'Actual Cost', type: 'Currency', precision: 18, scale: 2 },
    { apiName: 'ExpectedResponse', label: 'Expected Response (%)', type: 'Percent', precision: 8, scale: 2 },
    { apiName: 'NumberSent', label: 'Num Sent', type: 'Number', precision: 18, scale: 0 },
    { apiName: 'ParentId', label: 'Parent Campaign', type: 'Lookup', referenceTo: 'Campaign', relationshipName: 'ChildCampaigns' },
    {
      apiName: 'NumberOfResponses', label: 'Responses in Campaign', type: 'RollupSummary',
      rollup: { childObject: 'CampaignMember', relationshipField: 'CampaignId', operation: 'COUNT', filters: [{ field: 'HasResponded', op: 'equals', value: true }] }
    },
    {
      apiName: 'NumberOfMembers', label: 'Members in Campaign', type: 'RollupSummary',
      rollup: { childObject: 'CampaignMember', relationshipField: 'CampaignId', operation: 'COUNT' }
    },
    { apiName: 'Description', label: 'Description', type: 'LongTextArea' }
  ],
  highlights: ['Name', 'Type', 'Status', 'StartDate', 'NumberOfMembers'],
  listViews: [
    { apiName: 'All', label: 'All Campaigns', columns: ['Name', 'Type', 'Status', 'StartDate', 'NumberOfMembers', 'NumberOfResponses'] },
    { apiName: 'Active', label: 'Active Campaigns', columns: ['Name', 'Type', 'Status', 'StartDate', 'EndDate'], filters: [{ field: 'IsActive', op: 'equals', value: true }] }
  ]
};

export const CAMPAIGN_MEMBER: ObjectSpec = {
  apiName: 'CampaignMember',
  label: 'Campaign Member',
  pluralLabel: 'Campaign Members',
  icon: 'campaign_members',
  color: '#F49756',
  nameFieldType: 'AutoNumber',
  autoNumberFormat: 'CM-{000000}',
  nameFieldLabel: 'Campaign Member Number',
  activitiesEnabled: false,
  fields: [
    { apiName: 'CampaignId', label: 'Campaign', type: 'MasterDetail', referenceTo: 'Campaign', relationshipName: 'CampaignMembers', required: true },
    { apiName: 'LeadId', label: 'Lead', type: 'Lookup', referenceTo: 'Lead', relationshipName: 'CampaignMembers' },
    { apiName: 'ContactId', label: 'Contact', type: 'Lookup', referenceTo: 'Contact', relationshipName: 'CampaignMembers' },
    { apiName: 'Status', label: 'Status', type: 'Picklist', picklist: { values: [{ value: 'Sent', default: true }, { value: 'Responded', meta: { responded: true } }] } },
    { apiName: 'HasResponded', label: 'Responded', type: 'Checkbox' },
    { apiName: 'FirstRespondedDate', label: 'First Responded Date', type: 'Date' }
  ],
  validationRules: [
    {
      apiName: 'Lead_or_Contact_required',
      formula: 'AND(ISBLANK(LeadId), ISBLANK(ContactId))',
      errorMessage: 'A campaign member must reference a lead or a contact.'
    }
  ]
};

export const TASK: ObjectSpec = {
  apiName: 'Task',
  label: 'Task',
  pluralLabel: 'Tasks',
  icon: 'task',
  color: '#4BC076',
  nameFieldApi: 'Subject',
  nameFieldLabel: 'Subject',
  feedEnabled: false,
  activitiesEnabled: false,
  fields: [
    { apiName: 'WhoId', label: 'Name', type: 'Lookup', referenceTo: 'Contact,Lead', relationshipName: 'Tasks' },
    { apiName: 'WhatId', label: 'Related To', type: 'Lookup', referenceTo: '*', relationshipName: 'Tasks' },
    {
      apiName: 'Status', label: 'Status', type: 'Picklist', required: true,
      picklist: {
        values: [
          { value: 'Not Started', default: true },
          { value: 'In Progress' },
          { value: 'Completed', meta: { closed: true } },
          { value: 'Waiting on someone else' },
          { value: 'Deferred' }
        ]
      }
    },
    { apiName: 'Priority', label: 'Priority', type: 'Picklist', required: true, picklist: { values: ['High', { value: 'Normal', default: true }, 'Low'] } },
    { apiName: 'ActivityDate', label: 'Due Date', type: 'Date' },
    { apiName: 'IsClosed', label: 'Closed', type: 'Checkbox' },
    { apiName: 'CompletedDateTime', label: 'Completed Date/Time', type: 'DateTime' },
    { apiName: 'Description', label: 'Comments', type: 'LongTextArea' }
  ],
  highlights: ['Subject', 'Status', 'Priority', 'ActivityDate', 'OwnerId'],
  listViews: [
    { apiName: 'Open', label: 'Open Tasks', columns: ['Subject', 'WhoId', 'WhatId', 'ActivityDate', 'Status', 'Priority', 'OwnerId'], filters: [{ field: 'IsClosed', op: 'equals', value: false }] },
    { apiName: 'MyOpen', label: 'My Open Tasks', columns: ['Subject', 'WhoId', 'WhatId', 'ActivityDate', 'Status', 'Priority'], scope: 'mine', filters: [{ field: 'IsClosed', op: 'equals', value: false }] }
  ]
};

export const EVENT: ObjectSpec = {
  apiName: 'Event',
  label: 'Event',
  pluralLabel: 'Events',
  icon: 'event',
  color: '#EB7092',
  nameFieldApi: 'Subject',
  nameFieldLabel: 'Subject',
  feedEnabled: false,
  activitiesEnabled: false,
  fields: [
    { apiName: 'WhoId', label: 'Name', type: 'Lookup', referenceTo: 'Contact,Lead', relationshipName: 'Events' },
    { apiName: 'WhatId', label: 'Related To', type: 'Lookup', referenceTo: '*', relationshipName: 'Events' },
    { apiName: 'StartDateTime', label: 'Start', type: 'DateTime', required: true },
    { apiName: 'EndDateTime', label: 'End', type: 'DateTime' },
    { apiName: 'Location', label: 'Location', type: 'Text', length: 255 },
    { apiName: 'IsAllDayEvent', label: 'All-Day Event', type: 'Checkbox' },
    { apiName: 'Type', label: 'Type', type: 'Picklist', picklist: { values: [{ value: 'Meeting', default: true }, 'Call', 'Email', 'Other'] } },
    { apiName: 'ShowAs', label: 'Show Time As', type: 'Picklist', picklist: { values: [{ value: 'Busy', default: true }, 'Free', 'Out of Office'] } },
    { apiName: 'Description', label: 'Description', type: 'LongTextArea' }
  ]
};

export const USER: ObjectSpec = {
  apiName: 'User',
  label: 'User',
  pluralLabel: 'Users',
  icon: 'user',
  color: '#65CAE4',
  sharingModel: 'Read',
  feedEnabled: false,
  historyEnabled: false,
  activitiesEnabled: false,
  fields: [
    { apiName: 'Username', label: 'Username', type: 'Text', length: 80, required: true, unique: true },
    { apiName: 'Email', label: 'Email', type: 'Email', required: true },
    { apiName: 'FirstName', label: 'First Name', type: 'Text', length: 40 },
    { apiName: 'LastName', label: 'Last Name', type: 'Text', length: 80, required: true },
    { apiName: 'Alias', label: 'Alias', type: 'Text', length: 8 },
    { apiName: 'IsActive', label: 'Active', type: 'Checkbox', defaultValue: 'true' },
    { apiName: 'Title', label: 'Title', type: 'Text', length: 80 },
    { apiName: 'Department', label: 'Department', type: 'Text', length: 80 },
    { apiName: 'CompanyName', label: 'Company Name', type: 'Text', length: 80 },
    { apiName: 'Phone', label: 'Phone', type: 'Phone' },
    { apiName: 'MobilePhone', label: 'Mobile', type: 'Phone' },
    { apiName: 'ProfileId', label: 'Profile', type: 'Lookup', referenceTo: 'Profile', relationshipName: 'Users' },
    { apiName: 'UserRoleId', label: 'Role', type: 'Lookup', referenceTo: 'UserRole', relationshipName: 'Users' },
    { apiName: 'ManagerId', label: 'Manager', type: 'Lookup', referenceTo: 'User', relationshipName: 'ManagedUsers' },
    { apiName: 'TimeZoneSidKey', label: 'Time Zone', type: 'Picklist', picklist: { values: [{ value: 'Europe/London', default: true }, 'Europe/Paris', 'America/New_York', 'America/Los_Angeles', 'Asia/Dubai', 'Asia/Singapore', 'Australia/Sydney'] } },
    { apiName: 'LocaleSidKey', label: 'Locale', type: 'Picklist', picklist: { values: [{ value: 'en_GB', default: true }, 'en_US', 'fr_FR', 'de_DE', 'es_ES'] } },
    { apiName: 'LanguageLocaleKey', label: 'Language', type: 'Picklist', picklist: { values: [{ value: 'en_US', default: true }, 'fr', 'de', 'es'] } },
    { apiName: 'DefaultCurrencyIsoCode', label: 'Currency', type: 'Picklist', picklist: { values: [{ value: 'GBP', default: true }, 'USD', 'EUR'] } },
    { apiName: 'AboutMe', label: 'About Me', type: 'LongTextArea' },
    { apiName: 'FederationIdentifier', label: 'Federation ID', type: 'Text', length: 512 }
  ]
};

export const PRODUCT2: ObjectSpec = {
  apiName: 'Product2',
  label: 'Product',
  pluralLabel: 'Products',
  icon: 'product',
  color: '#7A9AE6',
  fields: [
    { apiName: 'ProductCode', label: 'Product Code', type: 'Text', length: 255, externalId: true },
    { apiName: 'IsActive', label: 'Active', type: 'Checkbox' },
    { apiName: 'Family', label: 'Product Family', type: 'Picklist', picklist: { values: ['Membership Fees', 'Food & Beverage', 'Room Hire', 'Events', 'Merchandise', 'Other'] } },
    { apiName: 'Description', label: 'Product Description', type: 'LongTextArea' }
  ]
};

export const PRICEBOOK2: ObjectSpec = {
  apiName: 'Pricebook2',
  label: 'Price Book',
  pluralLabel: 'Price Books',
  icon: 'pricebook',
  color: '#7A9AE6',
  activitiesEnabled: false,
  fields: [
    { apiName: 'IsActive', label: 'Active', type: 'Checkbox' },
    { apiName: 'IsStandard', label: 'Is Standard Price Book', type: 'Checkbox' },
    { apiName: 'Description', label: 'Description', type: 'LongTextArea' }
  ]
};

export const PRICEBOOK_ENTRY: ObjectSpec = {
  apiName: 'PricebookEntry',
  label: 'Price Book Entry',
  pluralLabel: 'Price Book Entries',
  icon: 'pricebook',
  color: '#7A9AE6',
  nameFieldType: 'AutoNumber',
  autoNumberFormat: 'PBE-{000000}',
  activitiesEnabled: false,
  feedEnabled: false,
  fields: [
    { apiName: 'Pricebook2Id', label: 'Price Book', type: 'MasterDetail', referenceTo: 'Pricebook2', relationshipName: 'PricebookEntries', required: true },
    { apiName: 'Product2Id', label: 'Product', type: 'Lookup', referenceTo: 'Product2', relationshipName: 'PricebookEntries', required: true },
    { apiName: 'UnitPrice', label: 'List Price', type: 'Currency', precision: 18, scale: 2, required: true },
    { apiName: 'IsActive', label: 'Active', type: 'Checkbox' }
  ]
};

export const OPPORTUNITY_LINE_ITEM: ObjectSpec = {
  apiName: 'OpportunityLineItem',
  label: 'Opportunity Product',
  pluralLabel: 'Opportunity Products',
  icon: 'opportunity',
  color: '#FCB95B',
  nameFieldType: 'AutoNumber',
  autoNumberFormat: 'OLI-{000000}',
  activitiesEnabled: false,
  feedEnabled: false,
  fields: [
    { apiName: 'OpportunityId', label: 'Opportunity', type: 'MasterDetail', referenceTo: 'Opportunity', relationshipName: 'OpportunityLineItems', required: true },
    { apiName: 'Product2Id', label: 'Product', type: 'Lookup', referenceTo: 'Product2', relationshipName: 'OpportunityLineItems', required: true },
    { apiName: 'Quantity', label: 'Quantity', type: 'Number', precision: 12, scale: 2, required: true },
    { apiName: 'UnitPrice', label: 'Sales Price', type: 'Currency', precision: 18, scale: 2, required: true },
    { apiName: 'TotalPrice', label: 'Total Price', type: 'Formula', formula: 'Quantity * UnitPrice', formulaReturnType: 'Currency' },
    { apiName: 'ServiceDate', label: 'Service Date', type: 'Date' },
    { apiName: 'Description', label: 'Line Description', type: 'TextArea' }
  ]
};

export const EMAIL_MESSAGE: ObjectSpec = {
  apiName: 'EmailMessage',
  label: 'Email Message',
  pluralLabel: 'Email Messages',
  icon: 'email',
  color: '#95AEC5',
  nameFieldApi: 'Subject',
  nameFieldLabel: 'Subject',
  feedEnabled: false,
  activitiesEnabled: false,
  fields: [
    { apiName: 'ParentId', label: 'Case', type: 'Lookup', referenceTo: 'Case', relationshipName: 'EmailMessages' },
    { apiName: 'FromAddress', label: 'From Address', type: 'Email' },
    { apiName: 'ToAddress', label: 'To Address', type: 'TextArea' },
    { apiName: 'CcAddress', label: 'CC Address', type: 'TextArea' },
    { apiName: 'Incoming', label: 'Is Incoming', type: 'Checkbox' },
    { apiName: 'TextBody', label: 'Text Body', type: 'LongTextArea' },
    { apiName: 'HtmlBody', label: 'HTML Body', type: 'LongTextArea' },
    { apiName: 'MessageDate', label: 'Message Date', type: 'DateTime' },
    { apiName: 'Status', label: 'Status', type: 'Picklist', picklist: { values: [{ value: 'New', default: true }, 'Read', 'Replied', 'Sent', 'Forwarded'] } }
  ]
};

export const CASE_COMMENT: ObjectSpec = {
  apiName: 'CaseComment',
  label: 'Case Comment',
  pluralLabel: 'Case Comments',
  icon: 'case_comment',
  color: '#F2CF5B',
  nameFieldType: 'AutoNumber',
  autoNumberFormat: 'CC-{000000}',
  feedEnabled: false,
  activitiesEnabled: false,
  searchEnabled: false,
  fields: [
    { apiName: 'ParentId', label: 'Case', type: 'MasterDetail', referenceTo: 'Case', relationshipName: 'CaseComments', required: true },
    { apiName: 'CommentBody', label: 'Body', type: 'LongTextArea', required: true },
    { apiName: 'IsPublished', label: 'Published', type: 'Checkbox' }
  ]
};

/** Install order matters: referenced objects before referencing ones. */
export const STANDARD_OBJECTS: ObjectSpec[] = [
  USER,
  ACCOUNT,
  CONTACT,
  CAMPAIGN,
  LEAD,
  PRICEBOOK2,
  PRODUCT2,
  OPPORTUNITY,
  PRICEBOOK_ENTRY,
  OPPORTUNITY_LINE_ITEM,
  CASE,
  CASE_COMMENT,
  CAMPAIGN_MEMBER,
  TASK,
  EVENT,
  EMAIL_MESSAGE
];
