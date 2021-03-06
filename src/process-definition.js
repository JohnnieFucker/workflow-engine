var util = require('util');
var EventEmitter = require('events').EventEmitter;
var _ = require('lodash');
_.str = require('underscore.string');
_.mixin(_.str.exports());
var Promise = require("bluebird");

/**
* [CORE] Task Definition: Represent a abstract task in the process definition
*/
function Task(type) {
  this.id = null;
  this.name = null;
  this.type = type;
  this.incomingFlows = [];
  this.outgoingFlows = [];
}

Task.prototype.serialize = function () {
  function handleFlow(flow) {
    return {
        from: flow.from.id,
        to: flow.to.id,
        condition: flow.condition ? flow.condition.toString() : null
      };
  }
  var entity = {
    id: this.id,
    name: this.name,
    type: this.type,
    incomingFlows: this.incomingFlows.map(function (flow) {
      return handleFlow(flow);
    }),
    outgoingFlows: this.outgoingFlows.map(function (flow) {
      return handleFlow(flow);
    })
  };
  return entity;
};

Task.prototype.deserialize = function (entity) {
  this.id = entity.id;
  this.name = entity.name;
  this.type = entity.type;
};

/**
 * A factory method for deserialize the all kinds of Task
 * The subclass must provide a deserialize method in its prototype for extension
 * @param  {[TaskEntity]} entity
 * @return {[Task]}
 */
Task.deserialize = function (entity) {
  var task = processBuilder.createTask(entity.type);
  task.deserialize(entity);
  return task;
};


/**
 * The factory class to create different kinds of tasks for the client
 */
function ProcessBuilder() {
  this.startTask = function () {
    return new Task('start-task');
  };
  this.endTask = function () {
    return new Task('end-task');
  };
}
ProcessBuilder.prototype.registerTask = function (type, Task) {
  this[_.camelize(type)] = function () {
    var task = new Task();
    Task.apply(task, arguments);
    return task;
  };
};
ProcessBuilder.prototype.createTask = function (type) {
  return this[_.camelize(type)]();
};
var processBuilder = new ProcessBuilder();


/**
 * [CORE] The definiton of the process which can be executed by process engine
 */
function ProcessDefinition(name, engine) {
  this.engine = engine;
  this.name = name;
  this.tasks = {};
  this.nextTaskId = 0;
  this.layout = null;
  this.variables = {};
  this.category = "Default";
}

ProcessDefinition.prototype.addTask = function (task) {
  var id = task.id ? task.id : this.nextTaskId++;
  task.id = id;
  this.tasks[id] = task;
};
/**
 * create a flow
 * 
 * @param {[task]} taskFrom
 * @param {[task]} taskTo
 * @param {[function]} condition
 */
ProcessDefinition.prototype.addFlow = function (taskFrom, taskTo, condition) {
  if (!taskFrom || !taskTo)
    throw new Error('taskFrom or taskTo cannot be empty');

  var flow = {
    from: taskFrom,
    to: taskTo,
    condition: condition
  };
  taskTo.incomingFlows.push(flow);
  taskFrom.outgoingFlows.push(flow);
};

ProcessDefinition.prototype.serialize = function () {
  var tasks = [];
  _.forOwn(this.tasks, function (task) {
    tasks.push(task.serialize());
  }, this);

  var entity = {
    _id: this._id,
    name: this.name,
    tasks: tasks,
    variables: this.variables,
    category: this.category
  };

  return entity;
};

ProcessDefinition.deserialize = function (engine, entity) {
  var def = new ProcessDefinition(null, engine);
  def._id = entity._id;
  def.name = entity.name;
  def.variables = entity.variables;
  def.category = entity.category;
  entity.tasks.forEach(function (taskEntity) {
    def.addTask(Task.deserialize(taskEntity));
  });

  entity.tasks.forEach(function (taskEntity) {
    function deserializeFlow(flow) {
      var deserializedFlow = {
        from: def.tasks[flow.from],
        to: def.tasks[flow.to]
      };
      eval('deserializedFlow.condition = ' + flow.condition);
      return deserializedFlow;
    }

    def.tasks[taskEntity.id].incomingFlows = taskEntity.incomingFlows.map(function (flow) {
      return deserializeFlow(flow);
    });
    def.tasks[taskEntity.id].outgoingFlows = taskEntity.outgoingFlows.map(function (flow) {
      return deserializeFlow(flow);
    });
  });

  return def;
};

ProcessDefinition.prototype.save = function () {
  var entity = this.serialize();
  if (entity._id)
    return this.engine.definitionCollection.updateAsync({'_id': entity._id}, entity, {}).then(function() {
      return entity;
    });
  else
    return this.engine.definitionCollection.insertAsync(entity).then(function (entity) {
      this._id = entity._id;
      return this;
    }.bind(this));
};

var engineAPI = {
  createProcessDefinition: function (name) {
    return new ProcessDefinition(name, this);
  },

  loadProcessDefinition: function (id) {
    var engine = this;
    return engine.definitionCollection.findOneAsync({'_id': id}).then(function (entity) {
      return ProcessDefinition.deserialize(engine, entity);
    });
  },

  queryProcessDefinition: function (conditions, options) {
    var engine = this;
    if (!options)
      return engine.definitionCollection.findAsync(conditions);
    else
      return new Promise(function (resolve, reject) {
        var cursor = engine.definitionCollection.find(conditions);
        if (options.sort)
          cursor.sort(options.sort);
        if (options.limit)
          cursor.limit(options.limit);
        cursor.exec(function (err, result) {
          if (err) return reject(err);
          resolve(result);
        });
      });
  },

  importProcessDefinition: function(definition) {
    var engine = this;
    var processDefinition = engine.createProcessDefinition(definition.name);
    processDefinition.category = definition.category;

    var taskByName = {};
    _.each(definition.tasks, function (task_, name) {
      var task = processBuilder[task_.type] ? processBuilder[task_.type]() : processBuilder[task_.type + 'Task']();
      task.name = name;
      _.each(task_, function (value, key) {
        if (key !== 'type')
          task[key] = value;
      });

      processDefinition.addTask(task);
      taskByName[task.name] = task;
    });

    _.each(definition.flows, function (flow) {
      if (!taskByName[flow.from])
        throw new Error('task[' + flow.from + '] of flow.from does not exist');
      if (!taskByName[flow.to])
        throw new Error('task[' + flow.to + '] of flow.to does not exist');
      processDefinition.addFlow(taskByName[flow.from], taskByName[flow.to], flow.condition);
    });

    processDefinition.variables = _.clone(definition.variables, true);

    return processDefinition;
  }
};


ProcessDefinition.processBuilder = processBuilder;
ProcessDefinition.Task = Task;
ProcessDefinition.API = engineAPI;
module.exports = ProcessDefinition;

