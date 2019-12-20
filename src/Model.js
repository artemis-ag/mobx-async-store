import {
  reaction,
  computed,
  extendObservable,
  set,
  toJS,
  transaction,
  observable
} from 'mobx'

import moment from 'moment'

import { singularizeType } from './utils'

import ObjectPromiseProxy from './ObjectPromiseProxy'
import schema from './schema'

function isPresent (value) {
  return value !== null && value !== undefined && value !== ''
}

/**
 * returns `true` as long as the `value` is not `null`, `undefined`, or `''`
 * @method validatePresence
 * @param value
 */

function validatePresence (value) {
  return {
    isValid: isPresent(value),
    errors: [{
      key: 'blank',
      message: 'can\'t be blank'
    }]
  }
}

function stringifyIds (object) {
  Object.keys(object).forEach(key => {
    const property = object[key]
    if (typeof property === 'object') {
      if (property.id) {
        property.id = String(property.id)
      }
      stringifyIds(property)
    }
  })
}

/**
 * Helper method for apply the correct defaults to attributes.
 * @method defaultValueForDescriptor
 */
function defaultValueForDescriptor (descriptor, DataType) {
  if (typeof descriptor.initializer === 'function') {
    const value = descriptor.initializer()
    if (DataType.name === 'Date') {
      return moment(value).toDate()
    } else {
      return DataType(value)
    }
  }

  if (DataType.name === 'String') return ''
  if (DataType.name === 'Array') return []

  return null
}

/**
 * Defines attributes that will be serialized and deserialized. Takes one argument, a class that the attribute will be coerced to.
 * This can be a Javascript primitive or another class. `id` cannot be defined as it is assumed to exist.
 * Attributes can be defined with a default.
 * ```
 * class Todo extends Model {
 *   @attribute(Date) start_time = moment()
 * }
 * ```
 * @method attribute
 */
export function attribute (dataType = (obj) => obj) {
  return function (target, property, descriptor) {
    const { type } = target.constructor
    const defaultValue = defaultValueForDescriptor(descriptor, dataType)
    // Update the schema
    schema.addAttribute({
      dataType,
      defaultValue,
      property,
      type
    })
    // Return custom descriptor
    return {
      get () {
        return defaultValue
      },
      set (value) {
        set(target, property, value)
      }
    }
  }
}

/**
 * Defines validations for attributes that will be applied before saving. Takes one argument, a function to validate
 * the attribute. The default validator is `presence`: not `null`, `undefined`, or `''`.
 * ```
 * function nonzero(value => value !== 0)
 *
 * class Todo extends Model {
 *   `@validates`
 *   `@attribute`(nonzero) numberOfAssignees
 * }
 * ```
 * @method validates
 */

 export function validates (target, property) {
   let validator = validatePresence

   if (typeof target === 'function') {
     validator = target

     return function (target, property) {
       const { type } = target.constructor

       schema.addValidation({
         property,
         type,
         validator
       })
     }
   } else {
     const { type } = target.constructor
     schema.addValidation({
       property,
       type,
       validator
     })
   }
 }

/**
 * Handles getting polymorphic records or only a specific
 * type if specified.
 *
 * @method getRelatedRecords
 * @param {Object} record the record with the relationship
 * @param {String} property the related property to set
 * @param {String} modelType an override of the modelType
 */
export function getRelatedRecords (record, property, modelType = null) {
  const { relationships } = record

  const relationType = modelType || property

  const references = relationships && relationships[relationType]
  let relatedRecords = []

  // NOTE: If the record doesn't have a matching references for the relation type
  // fall back to looking up records by a foreign id i.e record.related_record_id
  if (references && references.data) {
    relatedRecords = references.data.map(ref => {
      const recordType = ref.type
      return record.store.getRecord(recordType, ref.id)
    })
  } else {
    const foreignId = `${singularizeType(record.type)}_id`
    relatedRecords = record.store
                           .getRecords(relationType)
                           .filter(rel => String(rel[foreignId]) === String(record.id))
  }

  return new RelatedRecordsArray(relatedRecords, record, relationType)
}

/**
 * Handles getting polymorphic has_one/belong_to.
 *
 * @method getRelatedRecord
 */
export function getRelatedRecord (record, property, modelType = null) {
  // Get relationships
  const { relationships } = record
  // Short circuit if no relationships are present
  if (!relationships) return
  // Use property name unless model type is provided
  const relationType = modelType || property
  const reference = relationships[relationType]
  // Short circuit if matching reference is not found
  if (!reference || !reference.data) return
  const { id, type } = relationships[relationType].data
  const recordType = modelType || type
  return record.store.getRecord(recordType, id)
}

/**
 * Handles setting polymorphic has_one/belong_to.
 * - Validates the related record to make sure it inherits from `Model` class
 * - Sets the relationship
 * - Attempts to find an inverse relationship, and if successful adds it as well
 *
 * @method setRelatedRecord
 * @param {Object} record the record with the relationship
 * @param {Object} relatedRecord the record that will be related
 * @param {String} property the related property to set
 * @param {String} modelType an override of the modelType
 */
export function setRelatedRecord (record, relatedRecord, property, modelType = null) {
  if (relatedRecord && !(relatedRecord instanceof Model)) {
    throw new Error('Related record must be a valid Model object')
  }
  const { relationships } = record

  const relationType = modelType || property
  const referenceRecord = relatedRecord || getRelatedRecord(record, relationType)

  if (!referenceRecord) { return }

  const { id } = referenceRecord
  const { type } = referenceRecord.constructor

  const data = relationships[relationType] && relationships[relationType].data

  if (!relatedRecord) {
    delete relationships[relationType]
  } else if (!data || !(data.type === type && data.id === id)) {
    relationships[relationType] = { data: { id, type } }
  } else {
    return relatedRecord
  }

  // hack we don't have a reference to the inverse name so we just use the record type.
  // this may cause problems with polymorphic relationships
  const inverseRelatedToMany = getRelatedRecords(referenceRecord, null, record.constructor.type)

  if (inverseRelatedToMany) {
    const inverseMethod = relatedRecord ? 'add' : 'remove'
    inverseRelatedToMany[inverseMethod](record)
  }

  return relatedRecord
}

/*
 * Defines a one-to-many relationship. Defaults to the class with camelized singular name of the property
 * An optional argument specifies the data model, if different from the property name
 * ```
 * class CropVariety extends Model {
 *   @relatedToMany growth_cycles
 * }
 *
 * class Crop extends Model {
 *   @relatedToMany(CropVariety) varieties
 * }
 * ```
 * @method relatedToMany
 */
export function relatedToMany (targetOrModelKlass, property, descriptor) {
  if (typeof targetOrModelKlass === 'function') {
    return function (target2, property2, descriptor2) {
      schema.addRelationship({
        type: target2.constructor.type,
        property: property2,
        dataType: Array
      })

      return {
        get () {
          const { type } = targetOrModelKlass
          return getRelatedRecords(this, property2, type)
        }
      }
    }
  } else {
    schema.addRelationship({
      type: targetOrModelKlass.constructor.type,
      property,
      dataType: Array
    })

    return {
      get () {
        return getRelatedRecords(this, property)
      }
    }
  }
}

/**
 * Syntactic sugar of relatedToMany relationship. Basically
 * everything the same except it only returns a single record.
 *
 * @method relatedToOne
 */
export function relatedToOne (targetOrModelKlass, property, descriptor) {
  if (typeof targetOrModelKlass === 'function') {
    return function (target2, property2, descriptor2) {
      schema.addRelationship({
        type: target2.constructor.type,
        property: property2,
        dataType: Object
      })

      return {
        get () {
          const { type } = targetOrModelKlass
          return getRelatedRecord(this, property2, type)
        },
        set (record) {
          const { type } = targetOrModelKlass
          return setRelatedRecord(this, record, property2, type)
        }
      }
    }
  } else {
    schema.addRelationship({
      type: targetOrModelKlass.constructor.type,
      property,
      dataType: Object
    })
    return {
      get () {
        return getRelatedRecord(this, property)
      },
      set (record) {
        return setRelatedRecord(this, record, property)
      }
    }
  }
}

/**
 * An array that allows for updating store references and relationships
 * @class RelatedRecordsArray
 * @constructor
 * @param {Array} array the array to extend
 * @param {Object} record the record with the referenced array
 * @param {String} property the property on the record that references the array
 */

class RelatedRecordsArray extends Array {
  constructor (array, record, property) {
    super(...array)
    this.property = property
    this.record = record
  }

  /**
   * Adds a record to the array, and updates references in the store, as well as inverse references
   * @method add
   * @param {Object} relatedRecord the record to add to the array
   * @return {Object} the original relatedRecord
   */
  add = (relatedRecord) => {
    const { record, property } = this
    const { constructor: { type: recordType } } = record
    const { id, constructor: { type } } = relatedRecord

    if (!relatedRecord || !(relatedRecord instanceof Model)) {
      throw new Error('Related record must be a valid Model object')
    }

    if (!record.relationships) {
      record.relationships = {}
    }

    const { relationships } = record

    if (!relationships[property]) {
      relationships[property] = {}
    }

    if (!relationships[property].data) {
      relationships[property].data = []
    }

    const existingRelationships = relationships[property]
    const alreadyThere = existingRelationships && existingRelationships.data.find((model) => model.id === id && model.type === type)
    if (!alreadyThere) {
      relationships[property].data.push({ id, type })
      this.push(relatedRecord)
      // setting the inverse - hack this will only work with singularized relationships.
      setRelatedRecord(relatedRecord, record, recordType.slice(0, recordType.length - 1))
    }

    record.isDirty = true

    return relatedRecord
  }

  /**
   * Removes a record from the array, and updates references in the store, as well as inverse references
   * @method remove
   * @param {Object} relatedRecord the record to remove from the array
   * @return {Object} the original relatedRecord
   */
  remove = (relatedRecord) => {
    const { record, property } = this
    const { relationships, constructor: { type: recordType } } = record
    const { id, constructor: { type } } = relatedRecord

    if (relationships && relationships[property] && relatedRecord) {
      const referenceIndexToRemove = relationships[property].data.findIndex((model) => model.id === id && model.type === type)
      relationships[property].data.splice(referenceIndexToRemove, 1)

      const recordIndexToRemove = this.findIndex((model) => model.id === id && model.type === type)
      if (recordIndexToRemove > 0) this.splice(recordIndexToRemove, 1)

      if (!relationships[property].data.length) {
        delete relationships[property]
      }

      if (!Object.keys(record.relationships).length) {
        delete record.relationships
      }

      // hack this will only work with singularized relationships.
      setRelatedRecord(relatedRecord, null, recordType.slice(0, recordType.length - 1))
    }

    record.isDirty = true

    return relatedRecord
  }

  replace = (array) => {
    const { record, property } = this
    const { relationships } = record

    transaction(() => {
      relationships[property] = { data: [] }
      array.forEach(object => this.add(object))
    })

    record.isDirty = true
  }
}

/*
 * Defines a many-to-one relationship. Defaults to the class with camelized name of the property.
 * An optional argument specifies the data model, if different from the property name.
 * ```
 * class Note extends Model {
 *   @belongsTo todo
 *   @belongsTo(Facility) greenhouse
 * }
 * ```
 * Polymorphic relationships
 * Define `belongsTo` with the the associated models
 * Define `hasMany` as you normally would
 * ```
 * class Note extends Model {
 *   @belongsTo(Todo, ScheduledEvent) notable
 * }
 *
 * class Todo extends Model {
 *   @hasMany notes
 * }
 * ```
 * @method belongsTo
 */

/**
 @class Model
 */
class Model {
  /**
   * Initializer for model
   *
   * @method constructor
   */
  constructor (initialAttributes = {}) {
    this._makeObservable(initialAttributes)
    this.setPreviousSnapshot()
    this._trackState()
  }

  /**
   * The type of the model. Defined on the class. Defaults to the underscored version of the class name
   * (eg 'calendar_events').
   *
   * @property type
   * @static
   */

  /**
   * The canonical path to the resource on the server. Defined on the class.
   * Defaults to the underscored version of the class name
   * @property endpoint
   * @static
   */

  /**
   * True if the instance has been modified from its persisted state
   * ```
   * kpi = store.add('kpis', { name: 'A good thing to measure' })
   * kpi.isDirty
   * => true
   * kpi.name
   * => "A good thing to measure"
   * await kpi.save()
   * kpi.isDirty
   * => false
   * kpi.name = "Another good thing to measure"
   * kpi.isDirty
   * => true
   * await kpi.save()
   * kpi.isDirty
   * => false
   * ```
   * @property isDirty
   * @type {Boolean}
   * @default false
   */
  @computed get isDirty () {
    const { isNew, _isDirty } = this
    return _isDirty || isNew
  }
  set isDirty (value) {
    this._isDirty = value
  }

  /**
   * Private method. True if the model has been programatically changed,
   * as opposed to just being new.
   * @property _isDirty
   * @type {Boolean}
   * @default false
   * @private
   */

  @observable _isDirty = false

  /**
   * True if the model has not been sent to the store
   * @property isNew
   * @type {Boolean}
   */
  @computed get isNew () {
    const { id } = this
    return !!String(id).match(/tmp/)
  }

  /**
   * True if the instance is coming from / going to the server
   * ```
   * kpi = store.find('kpis', 5)
   * // fetch started
   * kpi.isInFlight
   * => true
   * // fetch finished
   * kpi.isInFlight
   * => false
   * ```
   * @property isInFlight
   * @type {Boolean}
   * @default false
   */
  isInFlight = false

  /**
   * A hash of errors from the server
   * ```
   * kpi = store.find('kpis', 5)
   * kpi.errors
   * => { authorization: "You do not have access to this resource" }
   * ```
   * @property errors
   * @type {Object}
   * @default {}
   */
  @observable errors = {}

  /**
   * The previous state of defined attributes and relationships of the instance
   *
   * @property previousSnapshot
   * @type {Object}
   * @default {}
   */
  previousSnapshot = {}

  /**
   * restores data to its last persisted state
   * ```
   * kpi = store.find('kpis', 5)
   * kpi.name
   * => "A good thing to measure"
   * kpi.name = "Another good thing to measure"
   * kpi.rollback()
   * kpi.name
   * => "A good thing to measure"
   * ```
   * @method rollback
   */
  rollback () {
    transaction(() => {
      const { previousSnapshot } = this
      this.attributeNames.forEach((key) => {
        this[key] = previousSnapshot.attributes[key]
      })
      this.relationships = previousSnapshot.relationships
      this.errors = {}
    })
    this.setPreviousSnapshot()
  }

  /**
   * creates or updates a record.
   * @method save
   * @return {Promise}
   * @param {Object} options
   */
  save (options = {}) {
    if (!options.skip_validations && !this.validate()) {
      const errorString = JSON.stringify(this.errors)
      return Promise.reject(new Error(errorString))
    }

    const {
      queryParams,
      relationships,
      attributes
    } = options

    const { constructor, id, isNew } = this

    let requestId = id
    let method = 'PATCH'

    if (isNew) {
      method = 'POST'
      requestId = null
    }

    const url = this.store.fetchUrl(constructor.type, queryParams, requestId)

    const body = JSON.stringify(this.jsonapi(
      { relationships, attributes }
    ))

    const response = this.store.fetch(url, { method, body })

    return new ObjectPromiseProxy(response, this)
  }

  /**
   * Checks all validations, adding errors where necessary and returning `false` if any are not valid
   * @method validate
   * @return {Boolean}
   */

  validate () {
    this.errors = {}
    const { attributeNames, attributeDefinitions } = this
    const validationChecks = attributeNames.map((property) => {
      const { validator } = attributeDefinitions[property]

      if (!validator) return true

      const validationResult = validator(this[property], this)

      if (!validationResult.isValid) {
        this.errors[property] = validationResult.errors
      }

      return validationResult.isValid
    })
    return validationChecks.every(value => value)
  }

  /**
   * deletes a record from the store and server
   * @method destroy
   * @return {Promise} an empty promise with any success/error status
   */
  destroy (options = {}) {
    const {
      constructor: { type }, id, snapshot, isNew
    } = this

    if (isNew) {
      this.store.remove(type, id)
      return snapshot
    }

    const { params = {}, skipRemove = false } = options

    const url = this.store.fetchUrl(type, params, id)
    this.isInFlight = true
    const promise = this.store.fetch(url, { method: 'DELETE' })
    const _this = this
    _this.errors = {}

    return promise.then(
      async function (response) {
        _this.isInFlight = false
        if (response.status === 202 || response.status === 204) {
          if (!skipRemove) {
            _this.store.remove(type, id)
          }

          let json
          try {
            json = await response.json()
            if (json.data && json.data.attributes) {
              Object.keys(json.data.attributes).forEach(key => {
                set(_this, key, json.data.attributes[key])
              })
            }
          } catch (err) {
            console.log(err)
            // It is text, do you text handling here
          }

          // NOTE: If deleting a record changes other related model
          // You can return then in the delete response
          if (json && json.included) {
            _this.store.createModelsFromData(json.included)
          }

          return _this
        } else {
          _this.errors = { status: response.status }
          return _this
        }
      },
      function (error) {
        // TODO: Handle error states correctly
        _this.isInFlight = false
        _this.errors = error
        throw error
      }
    )
  }

   /* Private Methods */

  /**
   * Magic method that makes changes to records
   * observable
   *
   * @method _makeObservable
   */
  _makeObservable (initialAttributes) {
     const { defaultAttributes } = this

     extendObservable(this, {
       ...defaultAttributes,
       ...initialAttributes
     })
   }

  /**
   * The current state of defined attributes and relationships of the instance
   * Really just an alias for attributes
   * ```
   * todo = store.find('todos', 5)
   * todo.title
   * => "Buy the eggs"
   * snapshot = todo.snapshot
   * todo.title = "Buy the eggs and bacon"
   * snapshot.title
   * => "Buy the eggs and bacon"
   * ```
   * @method snapshot
   * @return {Object} current attributes
   */
  get snapshot () {
    return {
      attributes: this.attributes,
      relationships: toJS(this.relationships)
    }
  }

  /**
   * Sets previous snapshot to current snapshot
   *
   * @method setPreviousSnapshot
   */
  setPreviousSnapshot () {
    this.previousSnapshot = this.snapshot
  }

  /**
   * Uses mobx.autorun to track changes to attributes
   *
   * @method _trackState
   */
  _trackState () {
    reaction(
      () => JSON.stringify(this.attributes),
      objectString => {
        // console.log(objectString)
        this.isDirty = true
      }
    )

    reaction(
      () => JSON.stringify(this.relationships),
      relString => {
        // console.log(relString)
        this.isDirty = true
      }
    )
  }

  /**
   * shortcut to get the static
   *
   * @method type
   * @return {String} current attributes
  */
  get type () {
    return this.constructor.type
  }

  /**
   * current attributes of record
   *
   * @method attributes
   * @return {Object} current attributes
   */
  get attributes () {
    return this.attributeNames.reduce((attributes, key) => {
      const value = toJS(this[key])
      if (!value) {
        delete attributes[key]
      } else {
        attributes[key] = value
      }
      return attributes
    }, {})
  }

  /**
   * Getter find the attribute definition for the model type.
   *
   * @method attributeDefinitions
   * @return {Object}
   */
  get attributeDefinitions () {
    const { type } = this.constructor
    return schema.structure[type]
  }

  /**
   * Getter find the relationship definitions for the model type.
   *
   * @method relationshipDefinitions
   * @return {Object}
   */
  get relationshipDefinitions () {
    const { type } = this.constructor
    return schema.relations[type]
  }

  /**
   * Getter to check if the record has errors.
   *
   * @method hasErrors
   * @return {Boolean}
   */
  get hasErrors () {
    return Object.keys(this.errors).length > 0
  }

  /**
   * Getter to check if the record has errors.
   *
   * @method hasErrors
   * @return {Boolean}
   */
  errorForKey (key) {
    return this.errors[key]
  }

  /**
   * Getter to just get the names of a records attributes.
   *
   * @method attributeNames
   * @return {Array}
   */
  get attributeNames () {
    return Object.keys(this.attributeDefinitions)
  }

  /**
   * getter method to get the default attributes
   *
   * @method defaultAttributes
   * @return {Object}
   */
  get defaultAttributes () {
    const { attributeDefinitions } = this
    return this.attributeNames.reduce((defaults, key) => {
      const { defaultValue } = attributeDefinitions[key]
      defaults[key] = defaultValue
      return defaults
    }, {
      relationships: {}
    })
  }

  /**
   * getter method to get data in api compliance format
   * TODO: Figure out how to handle unpersisted ids
   *
   * @method jsonapi
   * @return {Object} data in JSON::API format
   */
  jsonapi (options = {}) {
    const {
      attributeDefinitions,
      attributeNames,
      meta,
      id,
      constructor: { type }
    } = this

    let filteredAttributeNames = attributeNames
    let filteredRelationshipNames = []

    if (options.attributes) {
      filteredAttributeNames = attributeNames
        .filter(name => options.attributes.includes(name))
    }

    const attributes = filteredAttributeNames.reduce((attrs, key) => {
      const value = this[key]
      if (value) {
        const { dataType: DataType } = attributeDefinitions[key]
        let attr
        if (DataType.name === 'Array' || DataType.name === 'Object') {
          attr = toJS(value)
        } else if (DataType.name === 'Date') {
          attr = moment(value).toISOString()
        } else {
          attr = DataType(value)
        }
        attrs[key] = attr
      } else {
        attrs[key] = value
      }
      return attrs
    }, {})

    const data = {
      type,
      attributes,
      id: String(id)
    }

    if (options.relationships) {
      filteredRelationshipNames = Object.keys(this.relationships)
        .filter(name => options.relationships.includes(name))

      const relationships = filteredRelationshipNames.reduce((rels, key) => {
        rels[key] = toJS(this.relationships[key])
        stringifyIds(rels[key])
        return rels
      }, {})

      data.relationships = relationships
    }

    if (meta) {
      data['meta'] = meta
    }

    if (String(id).match(/tmp/)) {
      delete data.id
    }

    return { data }
  }

  updateAttributes (attributes) {
    transaction(() => {
      Object.keys(attributes).forEach(key => {
        this[key] = attributes[key]
      })
    })
  }
}

export default Model
